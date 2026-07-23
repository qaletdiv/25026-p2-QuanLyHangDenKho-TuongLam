'use strict';

// WIP import (Phase 2b) — POST /mainline/wip-import.
// Primary role: own mainline_po_legs + leg lines (R3 overwrite, NK po_number+mode+crd).
//
// BOOTSTRAP (NetSuite-unavailable fallback): the WIP carries TRN/po_number/vendor/
// season/warehouse + SKU lines, so when the upstream hierarchy is ABSENT we also create
// po_masters/po_orders/po_order_lines from the WIP — but ONLY when missing. NetSuite stays
// the authority: an existing master/order is never overwritten, and order_lines are only
// derived (= Σ leg allocations per sku) for po_numbers that have none yet. So:
//   • NetSuite synced → it owns orders, WIP owns legs, R2 reconciles for real
//   • NetSuite absent → WIP bootstraps orders too; R2 trivially matches (single source)
//
// R2: after upsert, reconcile ordered vs allocated and return flags.

const { parseWipBuffer } = require('../../../services/wipParser');     // reuse existing parser
const MainlineLegModel = require('./MainlineLegModel');
const PoOrderModel = require('../../po/PoOrderModel');
const PoMasterModel = require('../../po/PoMasterModel');
const { loadResolvers } = require('../../po/resolvers');
const { reconcile } = require('./legReconciliationService');

// ---- pure core: upsert WIP legs (R3) ---------------------------------------
// parsedPOs: from wipParser — each { po_number, mode, crd, line_items:[{sku_code, expected_qty}] }
// existing : { legs, legLines }
// ctx      : { resolvers, knownPoNumbers:Set }
function upsertLegs(parsedPOs, existing, ctx) {
  const { resolvers, knownPoNumbers } = ctx;
  const legs = [...existing.legs];
  // leg lines grouped by leg_id so untouched legs keep their lines
  const linesByLeg = existing.legLines.reduce((m, l) => ((m[l.leg_id] = m[l.leg_id] || []).push(l), m), {});

  const nk = (po, mode, crd) => `${po}|${mode}|${crd || ''}`;
  const legIdx = new Map(legs.map((l, i) => [nk(l.po_number, l.mode_id, l.crd), i]));
  let nextId = legs.reduce((mx, l) => Math.max(mx, +String(l.id).replace(/\D/g, '') || 0), 0);

  const warnings = [];
  let added = 0, updated = 0;

  for (const po of parsedPOs) {
    if (!po.po_number) continue;
    if (!knownPoNumbers.has(po.po_number)) {
      warnings.push(`WIP leg for unknown po_number "${po.po_number}" — no NetSuite order yet`);
    }
    const modeId = resolvers.modeId(po.mode, `leg ${po.po_number}`);
    const key = nk(po.po_number, modeId, po.crd);

    let legId;
    const fields = {
      po_number:   po.po_number,
      mode_id:     modeId,
      incoterm_id: resolvers.incotermId(po.incoterm),
      crd:         po.crd || null,
      etd_pol:     po.etd_pol || null,
      e_del:       po.e_del || null,
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
      id:            `mll_${legId}_${li.sku_code}`,
      leg_id:        legId,
      sku_code:      li.sku_code,
      allocated_qty: Number(li.expected_qty) || 0,
    }));
  }

  return { legs, legLines: Object.values(linesByLeg).flat(), stats: { added, updated }, warnings };
}

// ---- pure core: bootstrap masters/orders/order_lines from WIP (fallback) ----
// Only fills what's MISSING — never overwrites NetSuite-sourced rows.
function bootstrapHierarchy(parsedPOs, { legs, legLines, masters, orders, orderLines, seasons, resolvers }) {
  const masterByTrn = new Map(masters.map((m) => [m.trn_number, m]));
  const orderByPo = new Map(orders.map((o) => [o.po_number, o]));
  const posWithLines = new Set(orderLines.map((l) => l.po_number));

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
    if (po.trn_number) {
      const m = masterByTrn.get(po.trn_number);
      if (!m) {
        masterByTrn.set(po.trn_number, {
          trn_number:    po.trn_number,
          supplier_id:   resolvers.supplierId(po.supplier, `TRN ${po.trn_number}`),
          season_id:     ensureSeason(po.season),
          main_shoulder: po.main_shoulder || null,
          netsuite_id:   null,
        });
        mAdded++;
      } else {
        let touched = false;
        if (!m.main_shoulder && po.main_shoulder) { m.main_shoulder = po.main_shoulder; touched = true; }
        if (!m.season_id && po.season) { m.season_id = ensureSeason(po.season); touched = true; }
        if (!m.supplier_id && po.supplier) { const s = resolvers.supplierId(po.supplier, `TRN ${po.trn_number}`); if (s) { m.supplier_id = s; touched = true; } }
        if (touched) mEnriched++;
      }
    }
    // --- order (po_number grain) ---
    if (po.po_number) {
      const o = orderByPo.get(po.po_number);
      if (!o) {
        const fc = resolvers.facilityChannel(po.receiving_warehouse, po.po_number);
        orderByPo.set(po.po_number, {
          po_number:             po.po_number,
          trn_number:            po.trn_number || null,
          facility_id:           fc.facility_id,
          allocation_channel_id: fc.allocation_channel_id,
          coo_country:           po.coo || null,
        });
        oAdded++;
      } else {
        let touched = false;
        if (!o.facility_id) {                    // resolve only when blank (avoids warning spam)
          const fc = resolvers.facilityChannel(po.receiving_warehouse, po.po_number);
          if (fc.facility_id) { o.facility_id = fc.facility_id; touched = true; }
          if (!o.allocation_channel_id && fc.allocation_channel_id) { o.allocation_channel_id = fc.allocation_channel_id; touched = true; }
        }
        if (!o.coo_country && po.coo) { o.coo_country = po.coo; touched = true; }
        if (!o.trn_number && po.trn_number) { o.trn_number = po.trn_number; touched = true; }
        if (touched) oEnriched++;
      }
    }
  }

  // order_lines = Σ allocated per (po_number, sku), ONLY for po_numbers with none yet.
  const poByLeg = new Map(legs.map((l) => [l.id, l.po_number]));
  const agg = new Map();
  legLines.forEach((ll) => {
    const po = poByLeg.get(ll.leg_id);
    if (!po || posWithLines.has(po)) return;
    const k = `${po}|${ll.sku_code}`;
    agg.set(k, (agg.get(k) || 0) + (ll.allocated_qty || 0));
  });
  let seq = orderLines.reduce((mx, l) => Math.max(mx, +String(l.id).replace(/\D/g, '') || 0), 0);
  const newLines = [...agg.entries()].map(([k, qty]) => {
    const [po_number, sku_code] = k.split('|');
    return { id: `pol_${++seq}`, po_number, sku_code, ordered_qty: qty, unit_price: null };
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
  const bySku = new Map(existingSkus.map((s) => [s.sku_code, s]));
  let added = 0;
  for (const po of parsedPOs) {
    for (const li of po.line_items || []) {
      if (!li.sku_code) continue;
      const cur = bySku.get(li.sku_code);
      if (!cur) {
        bySku.set(li.sku_code, {
          sku_code:    li.sku_code,
          style_color: li.style_color || null,
          item_name:   li.item_name || null,
          description: li.item_name || null,
          colorway:    li.colorway || null,
          size:        null,
          hts_code:    null,
          unit_price:  Number(li.unit_price) || null,
        });
        added++;
      } else {
        cur.style_color = cur.style_color || li.style_color || null;
        cur.item_name   = cur.item_name   || li.item_name   || null;
        cur.description = cur.description  || li.item_name   || null;
        cur.colorway    = cur.colorway    || li.colorway    || null;
        if (cur.unit_price == null && li.unit_price) cur.unit_price = Number(li.unit_price);
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

  const BM = require('../../../models/BaseModel');
  const SeasonModel = new BM('migrated/seasons.json');
  const SkuModel = new BM('migrated/product_skus.json');
  const [legs, legLines, masters, orders, orderLines, seasons, skus, resolvers] = await Promise.all([
    MainlineLegModel.readLegs(), MainlineLegModel.readLegLines(),
    PoMasterModel.read(), PoOrderModel.readOrders(), PoOrderModel.readOrderLines(), SeasonModel.read(), SkuModel.read(), loadResolvers(),
  ]);
  // po_numbers known either from existing orders OR this WIP (we'll bootstrap the latter),
  // so legs for WIP-introduced POs aren't spuriously flagged "unknown".
  const knownPoNumbers = new Set([...orders.map((o) => o.po_number), ...parsedPOs.map((p) => p.po_number)]);

  const result = upsertLegs(parsedPOs, { legs, legLines }, { resolvers, knownPoNumbers });

  await Promise.all([
    MainlineLegModel.writeLegs(result.legs),
    MainlineLegModel.writeLegLines(result.legLines),
  ]);

  // Bootstrap any MISSING upstream hierarchy from the WIP (NetSuite-absent fallback).
  const boot = bootstrapHierarchy(parsedPOs, {
    legs: result.legs, legLines: result.legLines, masters, orders, orderLines, seasons, resolvers,
  });
  // Populate the shared SKU master from the WIP's descriptive fields (3NF: SKU
  // attributes belong here, not on the line tables).
  const skuResult = upsertSkus(parsedPOs, skus);

  await Promise.all([
    PoMasterModel.write(boot.masters),
    PoOrderModel.writeOrders(boot.orders),
    PoOrderModel.writeOrderLines(boot.orderLines),
    SeasonModel.write(boot.seasons),
    SkuModel.write(skuResult.skus),
  ]);

  // R2 reconciliation against the (now possibly bootstrapped) order lines.
  const recon = reconcile(boot.orderLines, result.legs, result.legLines);

  res.json({
    ...result.stats,
    ...boot.stats,
    skus_upserted: skuResult.added,
    total: parsedPOs.length,
    parse_errors: errors,
    warnings: [...new Set([...result.warnings, ...resolvers.warnings])],
    reconciliation: { mismatch_count: recon.mismatches.length, checked: recon.checked, mismatches: recon.mismatches.slice(0, 100) },
  });
}

module.exports = { importWip, upsertLegs, bootstrapHierarchy, upsertSkus };
