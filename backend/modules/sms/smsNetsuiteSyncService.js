'use strict';

// SMS NetSuite sync — the SMS module's OWN sync, unrelated to the (deactivated)
// mainline one. Pulls POs tagged custbody_tt_po_type='smm' → sms_pos/sms_po_lines,
// and Item Receipts for those POs → sms_item_receipts/_lines.
//
// Ownership: NetSuite owns sms_pos + sms_po_lines outright (no portal-managed
// fields there) → wholesale upsert, no protect rules. Receipts accumulate per PO
// (many IRs → one po_number, summed in smsService.reconcilePo). The confirmation
// columns (matched_shipment_id / confirmed_by / confirmed_at) are PORTAL-owned:
// the old receiving-UI confirm was retired 2026-07-03, but matched_shipment_id was
// REACTIVATED 2026-07-22 to record which shipment (lot) an IR received — this is
// what targets a landed-cost push to the right IR when a PO has several receipts
// (see ../sms/receiptMatch + smsReceiptController). Re-syncing an IR refreshes its
// NS facts but NEVER touches these columns. Shared master data
// (suppliers/seasons/facilities/skus) is INSERT-only.

const M = require('./SmsModels');
const integrationService = require('../../services/integrationService');
const { splitWarehouseName, channelIdByName } = require('../po/warehouseFacility');

const { norm, supplierKey } = require('../../utils/nameKey');

// NS location string → { facility name, channel name }. The location conflates a
// physical facility with an allocation channel (Reserved / First); SMS keeps BOTH.
// The explicit map handles the "…First Inventory" / "…: Ten Tree" strings the
// generic splitter can't parse; otherwise splitWarehouseName strips a trailing
// Reserved/First suffix. Unresolved facility → null + warning (never guess).
const LOCATION_MAP = {
  'nri us first inventory':      { facility: 'NRI US', channel: 'First' },
  'nri us reserved inventory':   { facility: 'NRI US', channel: 'Reserved' },
  'nri canada first inventory':  { facility: 'NRI CA', channel: 'First' },
  'nri canada reserved inventory': { facility: 'NRI CA', channel: 'Reserved' },
  'direct shipment : ten tree':  { facility: 'Direct tentree', channel: null },
};
function resolveLocation(location) {
  const mapped = LOCATION_MAP[norm(location)];
  if (mapped) return { facilityName: mapped.facility, channelName: mapped.channel };
  const s = splitWarehouseName(location);
  return { facilityName: s.facilityName || null, channelName: s.channelName || null };
}

// ---- pure core (unit-testable; fetches injected) ----------------------------
function buildUpserts(nsPos, nsReceipts, existing) {
  const { suppliers, seasons, facilities, skus, pos, poLines, receipts, receiptLines } = existing;
  const warnings = [];
  const added = { suppliers: 0, seasons: 0 };

  // Suppliers match on supplierKey, NOT norm: NetSuite spells the vendor
  // "Best Star Fashions Co., Ltd." where the master data holds "Best Star Fashions
  // Co Ltd". Under norm those differ, so this insert-if-not-found path minted a
  // second row for the same vendor (six such pairs, merged 2026-08-12) and split
  // one supplier across two ids in reports, filters and the G1 booking guard.
  const supByName = new Map(suppliers.map((s) => [supplierKey(s.name), s]));
  const seasonByCode = new Map(seasons.map((s) => [norm(s.code), s]));
  const facByName = new Map(facilities.map((f) => [norm(f.name), f]));
  let nextSupId = suppliers.reduce((mx, s) => Math.max(mx, Number(s.id) || 0), 0);

  const supplierId = (name, ctx) => {
    if (!name) return null;
    let s = supByName.get(supplierKey(name));
    if (!s) { s = { id: String(++nextSupId), name: String(name).trim() }; suppliers.push(s); supByName.set(supplierKey(name), s); added.suppliers++; }
    return s.id;
  };
  const seasonId = (code) => {
    if (!code) return null;
    let s = seasonByCode.get(norm(code));
    if (!s) { s = { id: `season_${norm(code).replace(/[^a-z0-9]+/g, '_')}`, code: String(code).trim() }; seasons.push(s); seasonByCode.set(norm(code), s); added.seasons++; }
    return s.id;
  };
  // resolve a NS location to { facility_id, allocation_channel_id } in one pass
  const locationIds = (location, ctx) => {
    if (!location) return { facility_id: null, allocation_channel_id: null };
    const { facilityName, channelName } = resolveLocation(location);
    const f = facByName.get(norm(facilityName));
    if (!f) { warnings.push(`unresolved location "${location}"${ctx ? ' @ ' + ctx : ''}`); return { facility_id: null, allocation_channel_id: null }; }
    return {
      facility_id: f.id,
      allocation_channel_id: channelName ? (channelIdByName.get(norm(channelName)) || null) : null,
    };
  };

  // --- sms_pos + sms_po_lines: NS-owned, wholesale per PO ---
  const posByNumber = new Map(pos.map((p) => [p.po_number, p]));
  const linesByPo = poLines.reduce((m, l) => ((m[l.po_number] = m[l.po_number] || []).push(l), m), {});
  const skuByCode = new Map(skus.map((s) => [s.sku_code, s]));
  let lineSeq = poLines.reduce((mx, l) => Math.max(mx, +String(l.id).replace(/\D/g, '') || 0), 0);
  let posUpserted = 0, linesUpserted = 0, skusAdded = 0;

  for (const po of nsPos) {
    if (!po.po_number) continue;
    const loc = locationIds(po.receiving_warehouse, po.po_number);
    posByNumber.set(po.po_number, {
      po_number:       po.po_number,
      trn_number:      po.trn_number || null,
      supplier_id:     supplierId(po.supplier, po.po_number),
      season_id:       seasonId(po.season),
      hod:             po.hod || null,
      // NS "Due Date" (t.duedate) is labelled Expected Receive Date for SMS POs
      // (Lam, 2026-07-06) — the forecast's arrival anchor. mapSuiteQLRow already
      // surfaces duedate as etd_pol, so no query change is needed.
      expected_received_date: po.etd_pol || null,
      ship_method:     po.mode || null,
      approval_status: po.approval_status || null,
      facility_id:     loc.facility_id,
      allocation_channel_id: loc.allocation_channel_id,
      netsuite_id:     po.netsuite_id ? String(po.netsuite_id) : null,
    });
    posUpserted++;

    // IDENTITY = the NetSuite transaction LINE, not (po_number, sku_code).
    // NetSuite legitimately puts one item on several PO lines (split by receipt
    // date / location, or a price-correction line), so (po, sku) is NOT a
    // determinant — PO04792 carries 54 SKUs × 3 lines each, and PO04697 has the
    // same SKU at two different prices. Keying the row on `netsuite_line_id`
    // (a) makes the id STABLE across syncs — `spol_${++lineSeq}` renumbered every
    // row on every sync, so the PK churned constantly — and (b) gives Postgres a
    // real unique column to enforce. Consumers only ever aggregate per PO or per
    // (po, sku), so keeping both lines is lossless. Rows synced before this change
    // keep their old `spol_N` id and a null netsuite_line_id until their PO is
    // re-synced; Postgres allows multiple NULLs in a unique index, so both shapes
    // load. Fallback to the sequence only if NetSuite gave us no line id at all.
    linesByPo[po.po_number] = (po.line_items || []).map((li) => ({
      id: li.netsuite_line_id ? `spol_ns_${li.netsuite_line_id}` : `spol_${++lineSeq}`,
      po_number: po.po_number,
      sku_code: li.sku_code,
      ordered_qty: Number(li.expected_qty) || 0,
      unit_price: Number(li.unit_price) || null,
      netsuite_line_id: li.netsuite_line_id || null,
    }));
    linesUpserted += linesByPo[po.po_number].length;

    for (const li of po.line_items || []) {
      if (!li.sku_code) continue;
      // NS item description (e.g. "Wool Kurt Beanie (Meteorite Black Marled)"),
      // distinct from the sku_code (itemid). Guard against the old itemid-as-desc.
      const niceName = li.description && li.description !== li.sku_code ? li.description : null;
      // Descriptive attrs NetSuite may carry (see integrationService SKU_ATTR_COLUMNS).
      // The CI / packing list fall back to these when a vendor's sheet omits a column.
      const ATTRS = ['upc', 'gender', 'category', 'composition', 'knit_woven'];
      const existing = skuByCode.get(li.sku_code);
      if (existing) {
        // skus are otherwise INSERT-only, but backfill MISSING descriptive fields
        // from NetSuite so re-syncing populates rows synced before this fix.
        if (niceName && !existing.item_name) {
          existing.item_name = niceName;
          if (!existing.description) existing.description = li.description || null;
        }
        for (const a of ATTRS) if (li[a] && !existing[a]) existing[a] = li[a];
        // unit_price is a NetSuite-owned fact, corrected to transaction-currency
        // USD 2026-07-22. REFRESH it (not just backfill-if-missing) so rows synced
        // with the old inflated base-currency price self-correct on re-sync. Skip
        // 0/empty so a priceless line never clobbers a good value. A SKU on several
        // POs takes the last seen — sms_po_lines holds the authoritative per-PO
        // price; this master value is only a display fallback.
        if (li.unit_price && Number(li.unit_price) !== existing.unit_price) {
          existing.unit_price = Number(li.unit_price);
        }
        continue;
      }
      const parts = String(li.sku_code).split('-');
      const sku = {
        sku_code: li.sku_code,
        style_color: parts.slice(0, -1).join('-') || null,
        item_name: niceName,
        description: li.description || null,
        colorway: null,
        size: li.size || (parts.length > 2 ? parts[parts.length - 1] : null),
        hts_code: null,
        unit_price: Number(li.unit_price) || null,
      };
      for (const a of ATTRS) if (li[a]) sku[a] = li[a];
      skus.push(sku); skuByCode.set(sku.sku_code, sku); skusAdded++;
    }
  }

  // --- receipts: keyed on netsuite_ir_id; portal confirmation preserved ---
  const receiptByIr = new Map(receipts.filter((r) => r.netsuite_ir_id).map((r) => [r.netsuite_ir_id, r]));
  const knownPoNumbers = new Set(posByNumber.keys());
  let irSeq = receipts.reduce((mx, r) => Math.max(mx, +String(r.id).replace(/\D/g, '') || 0), 0);
  let receiptsUpserted = 0, receiptLinesUpserted = 0;
  const outReceipts = [...receipts];
  let outReceiptLines = [...receiptLines];

  for (const ir of nsReceipts) {
    if (!ir.po_number || !knownPoNumbers.has(ir.po_number)) {
      warnings.push(`IR ${ir.ir_tranid || ir.ir_id} references unknown SMS PO "${ir.po_number}" — skipped`);
      continue;
    }
    let r = receiptByIr.get(ir.ir_id);
    if (!r) {
      r = {
        id: `sir_${++irSeq}`,
        netsuite_ir_id: ir.ir_id,           // internal id — REST push target (itemReceipt/{id})
        netsuite_ir_tranid: ir.ir_tranid || null,  // document number (e.g. IR65377) — what users reconcile against
        po_number: ir.po_number,
        receipt_date: ir.receipt_date || null,
        source: 'netsuite',
        matched_shipment_id: null, confirmed_by: null, confirmed_at: null,
      };
      outReceipts.push(r);
      receiptByIr.set(ir.ir_id, r);
    } else {
      // refresh NS facts in place; NEVER touch the deactivated confirmation
      // columns (matched_shipment_id/confirmed_*) — reserved, see file header.
      r.po_number = ir.po_number;
      r.netsuite_ir_tranid = ir.ir_tranid || r.netsuite_ir_tranid || null;   // backfill on re-sync
      r.receipt_date = ir.receipt_date || r.receipt_date;
      r.source = 'netsuite';
    }
    receiptsUpserted++;
    outReceiptLines = outReceiptLines.filter((l) => l.receipt_id !== r.id);
    ir.lines.forEach((l, i) => outReceiptLines.push({ id: `sirl_${r.id.replace(/\D/g, '')}_${i + 1}`, receipt_id: r.id, sku_code: l.sku_code, qty: l.qty }));
    receiptLinesUpserted += ir.lines.length;
  }

  return {
    pos: [...posByNumber.values()],
    poLines: Object.values(linesByPo).flat(),
    receipts: outReceipts,
    receiptLines: outReceiptLines,
    suppliers, seasons, skus,
    stats: {
      pos_upserted: posUpserted, po_lines_upserted: linesUpserted,
      receipts_upserted: receiptsUpserted, receipt_lines_upserted: receiptLinesUpserted,
      skus_added: skusAdded, suppliers_added: added.suppliers, seasons_added: added.seasons,
    },
    warnings,
  };
}

// ---- IO entrypoint -----------------------------------------------------------
async function sync({ fetchPos, fetchReceipts } = {}) {
  const getPos = fetchPos || (() => integrationService.fetchNetSuitePOs({ type: 'sms' }));

  // Degrade gracefully — a bad token / network error reports, never 500s or mutates.
  // POs are fetched FIRST: Item Receipts are keyed to their source PO via the
  // receipt line's createdfrom, so we scope the receipt query to the SMS PO ids we
  // just pulled (fast; avoids scanning the whole receipt table). The receipt fetch
  // degrades to [] internally on error, so an IR problem never fails the whole sync.
  let nsPos = [], nsReceipts = [], fetchError = null;
  try {
    nsPos = await getPos();
    const poIds = nsPos.map((p) => p.netsuite_id).filter(Boolean);
    nsReceipts = fetchReceipts
      ? await fetchReceipts(poIds)
      : await integrationService.fetchNetSuiteItemReceipts(poIds);
  } catch (e) {
    fetchError = e.response?.data?.['o:errorDetails']?.[0]?.detail || e.message;
  }
  if (fetchError) return { fetch_error: fetchError, pos_upserted: 0 };
  if (!nsPos.length && !nsReceipts.length) return { pos_upserted: 0, receipts_upserted: 0, note: 'NetSuite returned no SMS POs or receipts' };

  const existing = {
    suppliers: await M.suppliers.read().catch(() => []),
    seasons: await M.seasons.read(),
    facilities: await M.facilities.read(),
    skus: await M.skus.read(),
    pos: await M.pos.read(),
    poLines: await M.poLines.read(),
    receipts: await M.receipts.read().catch(() => []),
    receiptLines: await M.receiptLines.read().catch(() => []),
  };

  const out = buildUpserts(nsPos, nsReceipts, existing);

  await Promise.all([
    M.suppliers.write(out.suppliers),
    M.seasons.write(out.seasons),
    M.skus.write(out.skus),
    M.pos.write(out.pos),
    M.poLines.write(out.poLines),
    M.receipts.write(out.receipts),
    M.receiptLines.write(out.receiptLines),
  ]);

  return { ...out.stats, warnings: [...new Set(out.warnings)] };
}

module.exports = { sync, buildUpserts };
