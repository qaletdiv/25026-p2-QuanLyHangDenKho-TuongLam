'use strict';

// SMS NetSuite sync — the SMS module's OWN sync, unrelated to the (deactivated)
// mainline one. Pulls POs tagged custbody_tt_po_type='smm' → sms_pos/sms_po_lines,
// and Item Receipts for those POs → sms_item_receipts/_lines.
//
// Ownership: NetSuite owns sms_pos + sms_po_lines outright (no portal-managed
// fields there) → wholesale upsert, no protect rules. Receipts accumulate per PO
// (many IRs → one poNumber, summed in smsService.reconcilePo). The confirmation
// columns (matchedShipmentId / confirmedBy / confirmedAt) are PORTAL-owned:
// the old receiving-UI confirm was retired 2026-07-03, but matchedShipmentId was
// REACTIVATED 2026-07-22 to record which shipment (lot) an IR received — this is
// what targets a landed-cost push to the right IR when a PO has several receipts
// (see ../sms/receiptMatch + smsReceiptController). Re-syncing an IR refreshes its
// NS facts but NEVER touches these columns. Shared master data
// (suppliers/seasons/facilities/skus) is INSERT-only.

const M = require('./SmsModels');
const integrationService = require('../../services/integrationService');
const { splitWarehouseName, channelIdByName } = require('../po/warehouseFacility');

const { norm, supplierKey } = require('../../utils/nameKey');
const { pruneStaleReceipts } = require('../../utils/pruneStaleReceipts');

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
  // resolve a NS location to { facilityId, allocationChannelId } in one pass
  const locationIds = (location, ctx) => {
    if (!location) return { facilityId: null, allocationChannelId: null };
    const { facilityName, channelName } = resolveLocation(location);
    const f = facByName.get(norm(facilityName));
    if (!f) { warnings.push(`unresolved location "${location}"${ctx ? ' @ ' + ctx : ''}`); return { facilityId: null, allocationChannelId: null }; }
    return {
      facilityId: f.id,
      allocationChannelId: channelName ? (channelIdByName.get(norm(channelName)) || null) : null,
    };
  };

  // --- sms_pos + sms_po_lines: NS-owned, wholesale per PO ---
  const posByNumber = new Map(pos.map((p) => [p.poNumber, p]));
  const linesByPo = poLines.reduce((m, l) => ((m[l.poNumber] = m[l.poNumber] || []).push(l), m), {});
  const skuByCode = new Map(skus.map((s) => [s.skuCode, s]));
  let lineSeq = poLines.reduce((mx, l) => Math.max(mx, +String(l.id).replace(/\D/g, '') || 0), 0);
  let posUpserted = 0, linesUpserted = 0, skusAdded = 0;

  for (const po of nsPos) {
    if (!po.poNumber) continue;
    const loc = locationIds(po.receivingWarehouse, po.poNumber);
    posByNumber.set(po.poNumber, {
      poNumber:       po.poNumber,
      trnNumber:      po.trnNumber || null,
      supplierId:     supplierId(po.supplier, po.poNumber),
      seasonId:       seasonId(po.season),
      hod:             po.hod || null,
      // NS "Due Date" (t.duedate) is labelled Expected Receive Date for SMS POs
      // (Lam, 2026-07-06) — the forecast's arrival anchor. mapSuiteQLRow already
      // surfaces duedate as etdPol, so no query change is needed.
      // `duedate` in NetSuite. SMS already treated it as the expected receive
      // date; the mapper now names it that instead of the old `etdPol` misnomer.
      expectedReceivedDate: po.expectedReceiveDate || null,
      shipMethod:     po.mode || null,
      approvalStatus: po.approvalStatus || null,
      facilityId:     loc.facilityId,
      allocationChannelId: loc.allocationChannelId,
      netsuiteId:     po.netsuiteId ? String(po.netsuiteId) : null,
    });
    posUpserted++;

    // IDENTITY = the NetSuite transaction LINE, not (poNumber, skuCode).
    // NetSuite legitimately puts one item on several PO lines (split by receipt
    // date / location, or a price-correction line), so (po, sku) is NOT a
    // determinant — PO04792 carries 54 SKUs × 3 lines each, and PO04697 has the
    // same SKU at two different prices. Keying the row on `netsuiteLineId`
    // (a) makes the id STABLE across syncs — `spol_${++lineSeq}` renumbered every
    // row on every sync, so the PK churned constantly — and (b) gives Postgres a
    // real unique column to enforce. Consumers only ever aggregate per PO or per
    // (po, sku), so keeping both lines is lossless. Rows synced before this change
    // keep their old `spol_N` id and a null netsuiteLineId until their PO is
    // re-synced; Postgres allows multiple NULLs in a unique index, so both shapes
    // load. Fallback to the sequence only if NetSuite gave us no line id at all.
    linesByPo[po.poNumber] = (po.line_items || []).map((li) => ({
      id: li.netsuiteLineId ? `spol_ns_${li.netsuiteLineId}` : `spol_${++lineSeq}`,
      poNumber: po.poNumber,
      skuCode: li.skuCode,
      orderedQty: Number(li.expectedQty) || 0,
      unitPrice: Number(li.unitPrice) || null,
      netsuiteLineId: li.netsuiteLineId || null,
    }));
    linesUpserted += linesByPo[po.poNumber].length;

    for (const li of po.line_items || []) {
      if (!li.skuCode) continue;
      // NS item description (e.g. "Wool Kurt Beanie (Meteorite Black Marled)"),
      // distinct from the skuCode (itemid). Guard against the old itemid-as-desc.
      const niceName = li.description && li.description !== li.skuCode ? li.description : null;
      // Descriptive attrs NetSuite may carry (see integrationService SKU_ATTR_COLUMNS).
      // The CI / packing list fall back to these when a vendor's sheet omits a column.
      const ATTRS = ['upc', 'gender', 'category', 'composition', 'knitWoven'];
      const existing = skuByCode.get(li.skuCode);
      if (existing) {
        // skus are otherwise INSERT-only, but backfill MISSING descriptive fields
        // from NetSuite so re-syncing populates rows synced before this fix.
        if (niceName && !existing.itemName) {
          existing.itemName = niceName;
          if (!existing.description) existing.description = li.description || null;
        }
        for (const a of ATTRS) if (li[a] && !existing[a]) existing[a] = li[a];
        // unitPrice is a NetSuite-owned fact, corrected to transaction-currency
        // USD 2026-07-22. REFRESH it (not just backfill-if-missing) so rows synced
        // with the old inflated base-currency price self-correct on re-sync. Skip
        // 0/empty so a priceless line never clobbers a good value. A SKU on several
        // POs takes the last seen — sms_po_lines holds the authoritative per-PO
        // price; this master value is only a display fallback.
        if (li.unitPrice && Number(li.unitPrice) !== existing.unitPrice) {
          existing.unitPrice = Number(li.unitPrice);
        }
        continue;
      }
      const parts = String(li.skuCode).split('-');
      const sku = {
        skuCode: li.skuCode,
        styleColor: parts.slice(0, -1).join('-') || null,
        itemName: niceName,
        description: li.description || null,
        colorway: null,
        size: li.size || (parts.length > 2 ? parts[parts.length - 1] : null),
        htsCode: null,
        unitPrice: Number(li.unitPrice) || null,
      };
      for (const a of ATTRS) if (li[a]) sku[a] = li[a];
      skus.push(sku); skuByCode.set(sku.skuCode, sku); skusAdded++;
    }
  }

  // --- receipts: keyed on netsuiteIrId; portal confirmation preserved ---
  const receiptByIr = new Map(receipts.filter((r) => r.netsuiteIrId).map((r) => [r.netsuiteIrId, r]));
  const knownPoNumbers = new Set(posByNumber.keys());
  let irSeq = receipts.reduce((mx, r) => Math.max(mx, +String(r.id).replace(/\D/g, '') || 0), 0);
  let receiptsUpserted = 0, receiptLinesUpserted = 0;
  const outReceipts = [...receipts];
  let outReceiptLines = [...receiptLines];

  for (const ir of nsReceipts) {
    if (!ir.poNumber || !knownPoNumbers.has(ir.poNumber)) {
      warnings.push(`IR ${ir.ir_tranid || ir.ir_id} references unknown SMS PO "${ir.poNumber}" — skipped`);
      continue;
    }
    let r = receiptByIr.get(ir.ir_id);
    if (!r) {
      r = {
        id: `sir_${++irSeq}`,
        netsuiteIrId: ir.ir_id,           // internal id — REST push target (itemReceipt/{id})
        netsuiteIrTranid: ir.ir_tranid || null,  // document number (e.g. IR65377) — what users reconcile against
        poNumber: ir.poNumber,
        receiptDate: ir.receiptDate || null,
        source: 'netsuite',
        matchedShipmentId: null, confirmedBy: null, confirmedAt: null,
      };
      outReceipts.push(r);
      receiptByIr.set(ir.ir_id, r);
    } else {
      // refresh NS facts in place; NEVER touch the deactivated confirmation
      // columns (matchedShipmentId/confirmed_*) — reserved, see file header.
      r.poNumber = ir.poNumber;
      r.netsuiteIrTranid = ir.ir_tranid || r.netsuiteIrTranid || null;   // backfill on re-sync
      r.receiptDate = ir.receiptDate || r.receiptDate;
      r.source = 'netsuite';
    }
    receiptsUpserted++;
    outReceiptLines = outReceiptLines.filter((l) => l.receiptId !== r.id);
    ir.lines.forEach((l, i) => outReceiptLines.push({ id: `sirl_${r.id.replace(/\D/g, '')}_${i + 1}`, receiptId: r.id, skuCode: l.skuCode, qty: l.qty }));
    receiptLinesUpserted += ir.lines.length;
  }

  // Receipts NetSuite has DELETED. The loop above only adds and refreshes, so an
  // IR deleted in NetSuite and replaced by a new one left the portal holding both
  // and reporting the SUM as received (PO04801: 658 against NetSuite's 329).
  // Scope = the POs this pull covered, since that is what the receipt query asked
  // about; see utils/pruneStaleReceipts for what it refuses to touch.
  const pruned = pruneStaleReceipts({
    nsReceipts,
    queriedPoNumbers: new Set(nsPos.map((p) => p.poNumber).filter(Boolean)),
    receipts: outReceipts,
    receiptLines: outReceiptLines,
  });
  const staleReceipts = pruned.removed;
  staleReceipts.forEach((r) => warnings.push(
    `Receipt ${r.ir} (${r.poNumber}) no longer exists in NetSuite — removed${r.was_confirmed ? ' (it carried a CONFIRMED match)' : ''}`,
  ));

  return {
    pos: [...posByNumber.values()],
    poLines: Object.values(linesByPo).flat(),
    receipts: pruned.receipts,
    receiptLines: pruned.receiptLines,
    suppliers, seasons, skus,
    stats: {
      pos_upserted: posUpserted, po_lines_upserted: linesUpserted,
      receipts_upserted: receiptsUpserted, receipt_lines_upserted: receiptLinesUpserted,
      receipts_removed: staleReceipts,
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
    const poIds = nsPos.map((p) => p.netsuiteId).filter(Boolean);
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
