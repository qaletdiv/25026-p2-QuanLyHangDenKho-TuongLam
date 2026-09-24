'use strict';

// WIP import (Phase 2b) — POST /mainline/wip-import.
// Primary role: own mainline_po_legs + leg lines (R3 overwrite, NK poNumber+mode+crd).
//
// BOOTSTRAP (NetSuite-unavailable fallback): the WIP carries TRN/poNumber/vendor/
// season/warehouse + SKU lines, so when the upstream hierarchy is ABSENT we also create
// po_masters/po_orders/po_order_lines from the WIP — but ONLY when missing. NetSuite stays
// the authority: an existing master/order is never overwritten, and order_lines are only
// derived (= Σ leg allocations per sku) for poNumbers that have none yet. So:
//   • NetSuite synced → it owns orders, WIP owns legs, R2 reconciles for real
//   • NetSuite absent → WIP bootstraps orders too; R2 trivially matches (single source)
//
// R2: after upsert, reconcile ordered vs allocated and return flags.

const { parseWipBuffer } = require('../../../services/wipParser');     // reuse existing parser
const { models } = require('../../../models');
const { loadResolvers } = require('../../po/resolvers');
const { reconcile } = require('./legReconciliationService');

// ---- pure core: upsert WIP legs (R3) ---------------------------------------
// parsedPOs: from wipParser — each { poNumber, mode, crd, line_items:[{skuCode, expectedQty}] }
// existing : { legs, legLines }
// ctx      : { resolvers, knownPoNumbers:Set }
function upsertLegs(parsedPOs, existing, ctx) {
  const { resolvers, knownPoNumbers } = ctx;
  const legs = [...existing.legs];
  // leg lines grouped by legId so untouched legs keep their lines
  const linesByLeg = existing.legLines.reduce((m, l) => ((m[l.legId] = m[l.legId] || []).push(l), m), {});

  const nk = (po, mode, crd) => `${po}|${mode}|${crd || ''}`;
  const legIdx = new Map(legs.map((l, i) => [nk(l.poNumber, l.modeId, l.crd), i]));
  let nextId = legs.reduce((mx, l) => Math.max(mx, +String(l.id).replace(/\D/g, '') || 0), 0);

  const warnings = [];
  let added = 0, updated = 0;

  for (const po of parsedPOs) {
    if (!po.poNumber) continue;
    if (!knownPoNumbers.has(po.poNumber)) {
      warnings.push(`WIP leg for unknown poNumber "${po.poNumber}" — no NetSuite order yet`);
    }
    const modeId = resolvers.modeId(po.mode, `leg ${po.poNumber}`);
    const key = nk(po.poNumber, modeId, po.crd);

    let legId;
    const fields = {
      poNumber:   po.poNumber,
      modeId:     modeId,
      incotermId: resolvers.incotermId(po.incoterm),
      crd:         po.crd || null,
      etdPol:     po.etdPol || null,
      eDel:       po.eDel || null,
    };

    if (legIdx.has(key)) {                    // R3: overwrite existing leg
      const i = legIdx.get(key);
      legId = legs[i].id;
      legs[i] = { id: legId, ...fields };
      updated++;
    } else {                                  // new leg
      legId = String(++nextId);
      legs.push({ id: legId, ...fields });
      legIdx.set(key, legs.length - 1);
      added++;
    }

    // replace this leg's lines (R3)
    linesByLeg[legId] = (po.line_items || []).map((li) => ({
      id:            `mll_${legId}_${li.skuCode}`,
      legId:        legId,
      skuCode:      li.skuCode,
      allocatedQty: Number(li.expectedQty) || 0,
    }));
  }

  return { legs, legLines: Object.values(linesByLeg).flat(), stats: { added, updated }, warnings };
}

// ---- pure core: bootstrap masters/orders/order_lines from WIP (fallback) ----
// Only fills what's MISSING — never overwrites NetSuite-sourced rows.
function bootstrapHierarchy(parsedPOs, { legs, legLines, masters, orders, orderLines, seasons, resolvers }) {
  const masterByTrn = new Map(masters.map((m) => [m.trnNumber, m]));
  const orderByPo = new Map(orders.map((o) => [o.poNumber, o]));
  const posWithLines = new Set(orderLines.map((l) => l.poNumber));

  // Seasons are a trivial code list — auto-create any the WIP introduces (avoids
  // a manual master-list step for each new season; resolvers stay read-only).
  const seasonList = [...(seasons || [])];
  const seasonByCode = new Map(seasonList.map((s) => [String(s.code).trim().toLowerCase(), s.id]));
  let seasonsAdded = 0;
  const ensureSeason = (code) => {
    if (!code) return null;
    const k = String(code).trim().toLowerCase();
    if (!seasonByCode.has(k)) {
      const id = `season_${seasonList.length + 1}`;
      seasonList.push({ id, code });
      seasonByCode.set(k, id);
      seasonsAdded++;
    }
    return seasonByCode.get(k);
  };

  // Field ownership: NetSuite owns row existence + supplier/season/qty/price; the WIP
  // owns the PLANNING attributes it carries — main/shoulder (NS doesn't fetch it at
  // all), destination facility, allocation channel, COO. So the WIP CREATES missing
  // masters/orders AND backfills those attributes onto existing (NS-synced) rows when
  // they're blank — fill-if-empty, never clobbering a value NetSuite already resolved.
  let mAdded = 0, oAdded = 0, mEnriched = 0, oEnriched = 0;
  for (const po of parsedPOs) {
    // --- master (TRN grain) ---
    if (po.trnNumber) {
      const m = masterByTrn.get(po.trnNumber);
      if (!m) {
        masterByTrn.set(po.trnNumber, {
          trnNumber:    po.trnNumber,
          supplierId:   resolvers.supplierId(po.supplier, `TRN ${po.trnNumber}`),
          seasonId:     ensureSeason(po.season),
          mainShoulder: po.mainShoulder || null,
          netsuiteId:   null,
        });
        mAdded++;
      } else {
        let touched = false;
        if (!m.mainShoulder && po.mainShoulder) { m.mainShoulder = po.mainShoulder; touched = true; }
        if (!m.seasonId && po.season) { m.seasonId = ensureSeason(po.season); touched = true; }
        if (!m.supplierId && po.supplier) { const s = resolvers.supplierId(po.supplier, `TRN ${po.trnNumber}`); if (s) { m.supplierId = s; touched = true; } }
        if (touched) mEnriched++;
      }
    }
    // --- order (poNumber grain) ---
    if (po.poNumber) {
      const o = orderByPo.get(po.poNumber);
      if (!o) {
        const fc = resolvers.facilityChannel(po.receivingWarehouse, po.poNumber);
        orderByPo.set(po.poNumber, {
          poNumber:             po.poNumber,
          trnNumber:            po.trnNumber || null,
          facilityId:           fc.facilityId,
          allocationChannelId: fc.allocationChannelId,
          cooCountry:           po.coo || null,
        });
        oAdded++;
      } else {
        let touched = false;
        if (!o.facilityId) {                    // resolve only when blank (avoids warning spam)
          const fc = resolvers.facilityChannel(po.receivingWarehouse, po.poNumber);
          if (fc.facilityId) { o.facilityId = fc.facilityId; touched = true; }
          if (!o.allocationChannelId && fc.allocationChannelId) { o.allocationChannelId = fc.allocationChannelId; touched = true; }
        }
        if (!o.cooCountry && po.coo) { o.cooCountry = po.coo; touched = true; }
        if (!o.trnNumber && po.trnNumber) { o.trnNumber = po.trnNumber; touched = true; }
        if (touched) oEnriched++;
      }
    }
  }

  // order_lines = Σ allocated per (poNumber, sku), ONLY for poNumbers with none yet.
  const poByLeg = new Map(legs.map((l) => [l.id, l.poNumber]));
  const agg = new Map();
  legLines.forEach((ll) => {
    const po = poByLeg.get(ll.legId);
    if (!po || posWithLines.has(po)) return;
    const k = `${po}|${ll.skuCode}`;
    agg.set(k, (agg.get(k) || 0) + (ll.allocatedQty || 0));
  });
  let seq = orderLines.reduce((mx, l) => Math.max(mx, +String(l.id).replace(/\D/g, '') || 0), 0);
  const newLines = [...agg.entries()].map(([k, qty]) => {
    const [poNumber, skuCode] = k.split('|');
    return { id: `pol_${++seq}`, poNumber, skuCode, orderedQty: qty, unitPrice: null };
  });

  return {
    masters:    [...masterByTrn.values()],
    orders:     [...orderByPo.values()],
    orderLines: [...orderLines, ...newLines],
    seasons:    seasonList,
    stats: { masters_bootstrapped: mAdded, orders_bootstrapped: oAdded, masters_enriched: mEnriched, orders_enriched: oEnriched, order_lines_bootstrapped: newLines.length, seasons_bootstrapped: seasonsAdded },
  };
}

// ---- pure core: populate the SHARED SKU master from WIP line items ----------
// 3NF: SKU descriptive attributes live in product_skus, never on the line tables.
// Fills missing fields only — never clobbers richer NetSuite/migration-sourced data.
function upsertSkus(parsedPOs, existingSkus) {
  const bySku = new Map(existingSkus.map((s) => [s.skuCode, s]));
  let added = 0;
  for (const po of parsedPOs) {
    for (const li of po.line_items || []) {
      if (!li.skuCode) continue;
      const cur = bySku.get(li.skuCode);
      if (!cur) {
        bySku.set(li.skuCode, {
          skuCode:    li.skuCode,
          styleColor: li.styleColor || null,
          itemName:   li.itemName || null,
          description: li.itemName || null,
          colorway:    li.colorway || null,
          size:        null,
          htsCode:    null,
          unitPrice:  Number(li.unitPrice) || null,
        });
        added++;
      } else {
        cur.styleColor = cur.styleColor || li.styleColor || null;
        cur.itemName   = cur.itemName   || li.itemName   || null;
        cur.description = cur.description  || li.itemName   || null;
        cur.colorway    = cur.colorway    || li.colorway    || null;
        if (cur.unitPrice == null && li.unitPrice) cur.unitPrice = Number(li.unitPrice);
      }
    }
  }
  return { skus: [...bySku.values()], added };
}

// ---- IO entrypoint ----------------------------------------------------------
async function importWip(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. Send Excel as multipart field "file".' });

  const { pos: parsedPOs, errors } = parseWipBuffer(req.file.buffer);
  if (!parsedPOs.length) return res.status(422).json({ error: 'No PO rows found in the uploaded file.', errors });

    const SeasonModel = models.seasons;
  const SkuModel = models.product_skus;
  const [legs, legLines, masters, orders, orderLines, seasons, skus, resolvers] = await Promise.all([
    models.mainline_po_legs.read(), models.mainline_po_leg_lines.read(),
    models.po_masters.read(), models.po_orders.read(), models.po_order_lines.read(), SeasonModel.read(), SkuModel.read(), loadResolvers(),
  ]);
  // poNumbers known either from existing orders OR this WIP (we'll bootstrap the latter),
  // so legs for WIP-introduced POs aren't spuriously flagged "unknown".
  const knownPoNumbers = new Set([...orders.map((o) => o.poNumber), ...parsedPOs.map((p) => p.poNumber)]);

  const result = upsertLegs(parsedPOs, { legs, legLines }, { resolvers, knownPoNumbers });

  await Promise.all([
    models.mainline_po_legs.write(result.legs),
    models.mainline_po_leg_lines.write(result.legLines),
  ]);

  // Bootstrap any MISSING upstream hierarchy from the WIP (NetSuite-absent fallback).
  const boot = bootstrapHierarchy(parsedPOs, {
    legs: result.legs, legLines: result.legLines, masters, orders, orderLines, seasons, resolvers,
  });
  // Populate the shared SKU master from the WIP's descriptive fields (3NF: SKU
  // attributes belong here, not on the line tables).
  const skuResult = upsertSkus(parsedPOs, skus);

  await Promise.all([
    models.po_masters.write(boot.masters),
    models.po_orders.write(boot.orders),
    models.po_order_lines.write(boot.orderLines),
    SeasonModel.write(boot.seasons),
    SkuModel.write(skuResult.skus),
  ]);

  // R2 reconciliation against the (now possibly bootstrapped) order lines, SCOPED TO
  // THE UPLOADED POs — an import response should describe the import. Unscoped, a
  // single-PO sheet reported every (po, sku) divergence in the whole order book
  // (2,640 on live data, of which 171 were the upload), with no baseline shown, so
  // there was no way to tell what the upload itself had caused.
  const uploadedPos = new Set(parsedPOs.map((p) => p.poNumber).filter(Boolean));
  const recon = reconcile(boot.orderLines, result.legs, result.legLines, { poNumbers: uploadedPos });

  res.json({
    ...result.stats,
    ...boot.stats,
    skus_upserted: skuResult.added,
    total: parsedPOs.length,
    parse_errors: errors,
    warnings: [...new Set([...result.warnings, ...resolvers.warnings])],
    reconciliation: {
      mismatch_count: recon.mismatches.length,
      checked: recon.checked,
      poNumbers: [...uploadedPos],   // lets the client name the PO when the sheet held just one
      mismatches: recon.mismatches.slice(0, 100),
    },
  });
}

module.exports = { importWip, upsertLegs, bootstrapHierarchy, upsertSkus };
