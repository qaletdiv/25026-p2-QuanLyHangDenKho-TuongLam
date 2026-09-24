'use strict';

// SMS derivations — status, rollups, reconciliation, IR auto-match. Everything
// here is computed at read-time and never stored (same rule as mainline).

// ---- shipment status --------------------------------------------------------
// DISPLAYED status = the latest courier tracking event mapped through
// courier_status_map; a shipment with no events falls back to the manually
// entered status. Returns { statusId, status, statusSource }.
//
// One step BEYOND the courier: Delivered means the courier handed the box over
// (FedEx scan / manual entry); RECEIVED means NetSuite has an Item Receipt for it,
// i.e. the warehouse actually booked the goods in. So a Delivered consignment is
// escalated to Received when every PO in it has an IR attributed to this lot —
// `receivedByShipment` from ./receiptMatch, passed in by the caller (omit it and
// the status simply stays Delivered, which is what the tracking poll wants).
// Received is DERIVED only: no courier code maps to it and it cannot be set by hand.
//
// THE ATTRIBUTION MUST BE HUMAN-CONFIRMED (tightened 2026-08-19, at Lam's call).
// receiptMatch attributes an IR to a lot by confirmed link → equal quantity →
// positional sequence. The last two are SUGGESTIONS: a real case (shipment 36 /
// PO04818 ↔ IR65720, sequence match, 218 received vs 222 shipped) read Received off
// a guess, and Received is a DONE state — it drops the row out of the active view,
// so a wrong guess buries the discrepancy instead of surfacing it. Requiring
// `confirmed` also aligns the status with the landed-cost push, which already
// refuses to post unless every PO's IR match is confirmed: "Received" and
// "postable" now mean the same thing. An unconfirmed candidate is still surfaced
// (received_* on the shipment payload) so the UI can say "IR found — confirm it",
// it just does not move the status. Confirming is one click on the Landed Costs page.
const DELIVERED_ID = 'sms_delivered';
const RECEIVED_ID = 'sms_received';

function deriveStatus(shipment, eventsByShipment, codeMap, statusNameById, receivedByShipment) {
  const events = eventsByShipment[shipment.id] || [];
  // Order by actual INSTANT — FedEx stamps each scan in the scan location's local
  // timezone (mixed offsets), so a string sort scrambles the sequence. Then use
  // the newest event whose code IS mapped, so an unmapped latest scan (e.g. an
  // exotic FedEx code) doesn't blank out the courier status.
  const byInstantDesc = [...events].sort((a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime));
  let base = null;
  for (const e of byInstantDesc) {
    const mapped = codeMap.get(`${shipment.courierId}|${e.courierCode}`);
    if (mapped) { base = { statusId: mapped, status: statusNameById.get(mapped) || null, statusSource: 'courier' }; break; }
  }
  if (!base) {
    base = {
      statusId: shipment.manualStatusId || null,
      status: statusNameById.get(shipment.manualStatusId) || null,
      statusSource: 'manual',
    };
  }
  // Only Delivered escalates. An earlier status with an IR attributed is left
  // alone on purpose — that means the tracking or the match is wrong, and quietly
  // marking it Received (a DONE state) would hide the discrepancy.
  const rec = receivedByShipment && receivedByShipment.get(shipment.id);
  if (base.statusId === DELIVERED_ID && rec && rec.confirmed) {
    return { statusId: RECEIVED_ID, status: statusNameById.get(RECEIVED_ID) || 'Received', statusSource: 'netsuite' };
  }
  return base;
}

// ---- price lookup (deterministic) -------------------------------------------
// NetSuite may carry one item on SEVERAL PO lines, so (poNumber, skuCode) can
// match more than one sms_po_lines row — and those rows can disagree on price
// (PO04697|ZCW6846-6340-S is 26.25 on one line and 49 on another). Building the
// lookup with `new Map(rows.map(...))` made the LAST row win, i.e. the answer
// depended on file order — and in Postgres, where row order is undefined, the same
// query could return either price. Since this value is the CI basis when a vendor's
// packing sheet omits the price, and the CI basis drives the landed cost that now
// posts to NetSuite, the tie-break must be explicit:
//   1. a line with orderedQty > 0 (the line actually being ordered)
//   2. else a line with a non-null price
//   3. else the lowest line identity (netsuiteLineId, then id) — stable, arbitrary
// Returns Map('poNumber|skuCode' → unitPrice | null).
function priceByPoSku(poLines) {
  const better = (a, b) => {
    if (!a) return b;
    const q = (l) => (Number(l.orderedQty) || 0) > 0 ? 1 : 0;
    if (q(b) !== q(a)) return q(b) > q(a) ? b : a;
    const p = (l) => (l.unitPrice == null ? 0 : 1);
    if (p(b) !== p(a)) return p(b) > p(a) ? b : a;
    const key = (l) => String(l.netsuiteLineId ?? '') + '|' + String(l.id ?? '');
    return key(b) < key(a) ? b : a;
  };
  const best = new Map();
  poLines.forEach((l) => {
    const k = `${l.poNumber}|${l.skuCode}`;
    best.set(k, better(best.get(k), l));
  });
  const out = new Map();
  best.forEach((l, k) => out.set(k, l.unitPrice ?? null));
  return out;
}

// ---- shipping-data (packing cartons) derivations ----------------------------
// Shipped truth per PO: if the vendor has uploaded shipping data (carton × SKU
// detail), shipped = Σ pcsPerCtn from those cartons (SKU-grained, confirmed);
// otherwise fall back to the declared Σ sms_shipment_pos.units (PO-grain estimate).
// Σ packing pcs per PO
function packingShippedByPo(packingCartons) {
  const m = new Map();
  packingCartons.forEach((c) => m.set(c.poNumber, (m.get(c.poNumber) || 0) + (Number(c.pcsPerCtn) || 0)));
  return m;
}
// Σ packing pcs per (po, sku)
function packingShippedByPoSku(packingCartons) {
  const m = new Map();
  packingCartons.forEach((c) => {
    const k = `${c.poNumber}|${c.skuCode}`;
    m.set(k, (m.get(k) || 0) + (Number(c.pcsPerCtn) || 0));
  });
  return m;
}
// Distinct physical cartons per PO from uploaded shipping data (unique ctnNumber).
// Used as the fallback carton count when the vendor didn't declare one at entry —
// the packing list is the actual truth (same spirit as packed pcs overriding
// declared units in poRollups). Pass cartons already scoped to the shipment.
function packingCartonsCountByPo(packingCartons) {
  const sets = new Map();
  packingCartons.forEach((c) => {
    if (c.ctnNumber == null) return;
    if (!sets.has(c.poNumber)) sets.set(c.poNumber, new Set());
    sets.get(c.poNumber).add(c.ctnNumber);
  });
  const m = new Map();
  sets.forEach((set, po) => m.set(po, set.size));
  return m;
}

// ---- carton facts (stored ONCE per physical carton, joined at read) ---------
// net/gross weight and measureCm describe the BOX, not the (box × SKU) line, so
// they live in `sms_cartons` keyed on (shipmentId, ctnNumber) — see the note on
// that table in database.dbml. They used to be repeated on every SKU row of the
// carton with only the FIRST row carrying real values and the siblings zeroed,
// which made every total depend on row order (undefined in SQL): Σ net weight read
// 827.8 counting each carton once vs 976.3 summing all rows.
//
// This joins the carton fact onto EVERY SKU row of that carton, so consumers that
// dedupe (packingSummary) and consumers that take the first row (plGenerator) both
// get the same answer no matter what order rows arrive in. Rows whose carton has no
// entry keep whatever they already carry, so a partially-migrated dataset still reads.
function withCartonFacts(skuRows, cartonRows = []) {
  const byKey = new Map(cartonRows.map((k) => [`${k.shipmentId}|${k.ctnNumber}`, k]));
  return skuRows.map((r) => {
    const k = byKey.get(`${r.shipmentId}|${r.ctnNumber}`);
    if (!k) return r;
    return {
      ...r,
      netWeightKgs: k.netWeightKgs ?? null,
      grossWeightKgs: k.grossWeightKgs ?? null,
      measureCm: k.measureCm ?? null,
    };
  });
}

// Packing summary for a set of carton rows (per shipment or per PO). Weights are
// carton-level facts so they're counted once per distinct carton; value is Σ line.
// Pass rows that already went through withCartonFacts when reading from storage.
function packingSummary(cartons) {
  const seenCtn = new Set();
  let pcs = 0, value = 0, net = 0, gross = 0, cbm = 0;
  cartons.forEach((c) => {
    pcs += Number(c.pcsPerCtn) || 0;
    value += Number(c.totalUsd) || (Number(c.pcsPerCtn) || 0) * (Number(c.unitPrice) || 0);
    // Dedupe on (shipment, carton), not ctnNumber alone: 14 ctnNumber values are
    // reused across shipments, so a caller that ever passes rows from more than one
    // consignment would silently drop the second shipment's identically-numbered
    // cartons. Every caller pre-scopes to one shipment today; this makes it safe
    // regardless. Falls back to ctnNumber for in-memory rows built at upload time,
    // which carry no shipmentId.
    const ctnKey = c.shipmentId != null ? `${c.shipmentId}|${c.ctnNumber}` : String(c.ctnNumber);
    if (!seenCtn.has(ctnKey)) {
      seenCtn.add(ctnKey);
      net += Number(c.netWeightKgs) || 0;
      gross += Number(c.grossWeightKgs) || 0;
      const d = String(c.measureCm || '').split(/[*×xX]/).map((p) => parseFloat(p.trim()));
      if (d.length === 3 && d.every((v) => !isNaN(v))) cbm += (d[0] * d[1] * d[2]) / 1e6;
    }
  });
  return {
    totalPcs: pcs, totalCartons: seenCtn.size, totalValue: +value.toFixed(2),
    totalNetWeight: +net.toFixed(2), totalGrossWeight: +gross.toFixed(2), totalCbm: +cbm.toFixed(3),
  };
}

// ---- per-PO rollups ---------------------------------------------------------
// ordered  = Σ sms_po_lines.orderedQty
// shipped  = Σ packing pcs when shipping data exists, else Σ sms_shipment_pos.units
// received = Σ sms_item_receipt_lines.qty (via the PO's receipts)
function poRollups({ poLines, shipmentPos, receipts, receiptLines, packingCartons = [] }) {
  const ordered = new Map();
  poLines.forEach((l) => ordered.set(l.poNumber, (ordered.get(l.poNumber) || 0) + (Number(l.orderedQty) || 0)));

  const declared = new Map();
  const lots = new Map();
  shipmentPos.forEach((j) => {
    declared.set(j.poNumber, (declared.get(j.poNumber) || 0) + (Number(j.units) || 0));
    lots.set(j.poNumber, Math.max(lots.get(j.poNumber) || 0, Number(j.lotNumber) || 0));
  });
  const packed = packingShippedByPo(packingCartons);
  // packed truth overrides declared where present
  const shipped = new Map(declared);
  packed.forEach((v, po) => shipped.set(po, v));

  const linesByReceipt = receiptLines.reduce((m, l) => ((m[l.receiptId] = (m[l.receiptId] || 0) + (Number(l.qty) || 0)), m), {});
  const received = new Map();
  receipts.forEach((r) => received.set(r.poNumber, (received.get(r.poNumber) || 0) + (linesByReceipt[r.id] || 0)));

  return { ordered, shipped, received, lots };
}

// ---- reconciliation (one PO) ------------------------------------------------
// PO grain: ordered vs shipped vs received (+remaining/variance). SKU grain:
// ordered vs SHIPPED vs received per SKU. Shipped-per-SKU comes from the uploaded
// shipping data (sms_packing_cartons); when none exists yet the per-SKU shipped
// is 0 (only the PO-grain declared total is known) and shipped_total falls back
// to the declared Σ sms_shipment_pos.units.
function reconcilePo(poNumber, { poLines, shipmentPos, receipts, receiptLines, packingCartons = [] }) {
  const myLines = poLines.filter((l) => l.poNumber === poNumber);
  const ordered_total = myLines.reduce((a, l) => a + (Number(l.orderedQty) || 0), 0);

  const myCartons = packingCartons.filter((c) => c.poNumber === poNumber);
  const hasShippingData = myCartons.length > 0;
  const declared_total = shipmentPos.filter((j) => j.poNumber === poNumber).reduce((a, j) => a + (Number(j.units) || 0), 0);
  const packed_total = myCartons.reduce((a, c) => a + (Number(c.pcsPerCtn) || 0), 0);
  const shipped_total = hasShippingData ? packed_total : declared_total;

  const shippedBySku = new Map();
  myCartons.forEach((c) => shippedBySku.set(c.skuCode, (shippedBySku.get(c.skuCode) || 0) + (Number(c.pcsPerCtn) || 0)));

  const myReceiptIds = new Set(receipts.filter((r) => r.poNumber === poNumber).map((r) => r.id));
  const myReceiptLines = receiptLines.filter((l) => myReceiptIds.has(l.receiptId));
  const received_total = myReceiptLines.reduce((a, l) => a + (Number(l.qty) || 0), 0);

  const receivedBySku = new Map();
  myReceiptLines.forEach((l) => receivedBySku.set(l.skuCode, (receivedBySku.get(l.skuCode) || 0) + (Number(l.qty) || 0)));

  const skuCodes = [...new Set([...myLines.map((l) => l.skuCode), ...shippedBySku.keys(), ...receivedBySku.keys()])].sort();
  const by_sku = skuCodes.map((skuCode) => {
    const orderedQty = myLines.filter((l) => l.skuCode === skuCode).reduce((a, l) => a + (Number(l.orderedQty) || 0), 0);
    const shippedQty = shippedBySku.get(skuCode) || 0;
    const receivedQty = receivedBySku.get(skuCode) || 0;
    // variance = shipped − received (matches PO-grain shipped_vs_received_variance).
    // >0 short-received / still in transit, <0 over-received. NOT vs ordered — an
    // un-shipped SKU isn't a receiving discrepancy, just not shipped yet.
    return { skuCode, orderedQty, shippedQty, receivedQty, variance: shippedQty - receivedQty };
  });

  return {
    poNumber: poNumber,
    ordered_total, shipped_total, received_total,
    hasShippingData: hasShippingData,
    remaining_to_ship: ordered_total - shipped_total,
    shipped_vs_received_variance: shipped_total - received_total,
    by_sku,
  };
}

// (The IR ↔ consignment auto-match suggestion was removed with the receiving
//  page 2026-07-03 — receipts sync from NetSuite and feed reconcilePo directly,
//  aggregated per PO, so no lot-level matching is needed.)

module.exports = { deriveStatus, poRollups, reconcilePo, packingSummary, packingShippedByPo, packingShippedByPoSku, packingCartonsCountByPo, priceByPoSku, withCartonFacts };
