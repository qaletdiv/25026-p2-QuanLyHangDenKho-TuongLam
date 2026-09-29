'use strict';

// Match an SMS shipment (one lot handed to the courier) to the NetSuite Item
// Receipt that received it — the link landed-cost push needs to target the right
// IR. Model (confirmed with Lam 2026-07-22): ONE shipment ↔ ONE IR per PO. When a
// PO ships in several lots, each lot's landed cost attaches to its own IR.
//
// Dates are NEVER matched for equality: courier + receiving lag makes the IR's
// receiptDate drift before/after the shipDate (real case: PO04821 ship 2026-07-22
// vs receipt 2026-07-21). So the signal hierarchy is:
//   1. quantity — an IR whose received qty equals the shipment's shipped pcs.
//   2. sequence — leftover shipments (ordered by lot, then shipDate) paired
//                 positionally with leftover IRs (ordered by receiptDate, then
//                 netsuiteIrId). Order, not date value, carries the signal.
// A human confirmation (sms_item_receipts.matchedShipmentId) overrides both.
// A human REJECTION (sms_receipt_match_rejections) is the negative of that: the
// pair is excluded from BOTH passes, so the next-best candidate surfaces instead
// of the suggestion the user already said no to. Without it, rejecting could only
// ever be cosmetic — the matcher is derived per read and would re-suggest it.
//
// PURE — no IO. Confidence lets the preview flag weak (sequence, qty-mismatch) links.

// shipments: [{ shipmentId, lotNumber, shipDate, shippedPcs }]
// irs:       [{ receiptId, netsuiteIrId, receiptDate, qty }]
// isRejected(shipmentId, receiptId) -> bool  (default: nothing rejected)
function matchPo(shipments = [], irs = [], isRejected = () => false) {
  const ships = [...shipments].sort((a, b) =>
    (Number(a.lotNumber) || 0) - (Number(b.lotNumber) || 0)
    || String(a.shipDate || '').localeCompare(String(b.shipDate || '')));
  const pool = [...irs].sort((a, b) =>
    String(a.receiptDate || '').localeCompare(String(b.receiptDate || ''))
    || String(a.netsuiteIrId || '').localeCompare(String(b.netsuiteIrId || '')));

  const used = new Set();
  const out = ships.map((s) => ({ shipmentId: s.shipmentId, shippedPcs: s.shippedPcs, _pending: true }));

  const free = (r, shipmentId) => !used.has(r.receiptId) && !isRejected(shipmentId, r.receiptId);

  // pass 1 — exact quantity (earliest unused IR with equal received qty)
  for (const row of out) {
    const hit = pool.find((r) => free(r, row.shipmentId) && Number(r.qty) === Number(row.shippedPcs));
    if (!hit) continue;
    used.add(hit.receiptId);
    Object.assign(row, {
      receiptId: hit.receiptId, netsuiteIrId: hit.netsuiteIrId, netsuiteIrTranid: hit.netsuiteIrTranid,
      receiptDate: hit.receiptDate, receiptQty: hit.qty,
      method: 'quantity', confidence: 'high', _pending: false,
    });
  }

  // pass 2 — sequence for the leftovers. "First still-free IR" rather than a
  // running index: with no rejections that IS the positional pairing (0,1,2…),
  // and a rejected pair simply falls through to the next candidate.
  const leftover = pool.filter((r) => !used.has(r.receiptId));
  for (const row of out) {
    if (!row._pending) { delete row._pending; continue; }
    const r = leftover.find((x) => free(x, row.shipmentId));
    if (r) {
      used.add(r.receiptId);
      Object.assign(row, {
        receiptId: r.receiptId, netsuiteIrId: r.netsuiteIrId, netsuiteIrTranid: r.netsuiteIrTranid,
        receiptDate: r.receiptDate, receiptQty: r.qty,
        method: 'sequence',
        // agreeing quantity in the sequence pass still earns high confidence
        confidence: Number(r.qty) === Number(row.shippedPcs) ? 'high' : 'medium',
      });
    } else {
      Object.assign(row, { receiptId: null, netsuiteIrId: null, netsuiteIrTranid: null, receiptDate: null, receiptQty: null, method: 'unmatched', confidence: 'low' });
    }
    delete row._pending;
  }
  return out;
}

// Σ shipped pcs for a (shipment, PO) from the uploaded packing cartons.
function shippedPcs(cartons, shipmentId, poNumber) {
  return cartons
    .filter((c) => c.shipmentId === shipmentId && c.poNumber === poNumber)
    .reduce((a, c) => a + (Number(c.pcsPerCtn) || 0), 0);
}

// Assignments for ONE PO — every shipment carrying it paired with its IR (or a
// null target). Confirmed matches (IR.matchedShipmentId) lock first; the
// remainder auto-matches via matchPo. `idx` is the shared lookup built by _index
// so callers resolving many POs don't rebuild it per PO.
// data: { junctions, cartons, receipts, receiptLines, shipments, rejections }
function _index({ shipments = [], receiptLines = [], rejections = [] }) {
  const rejected = new Set(rejections.map((r) => `${r.receiptId}|${r.shipmentId}`));
  return {
    shipById: new Map(shipments.map((s) => [s.id, s])),
    qtyByReceipt: receiptLines.reduce((m, l) => ((m[l.receiptId] = (m[l.receiptId] || 0) + (Number(l.qty) || 0)), m), {}),
    isRejected: (shipmentId, receiptId) => rejected.has(`${receiptId}|${shipmentId}`),
  };
}

function assignmentsForPo(po, data, idx = _index(data)) {
  const { junctions, cartons, receipts } = data;
  const shipsForPo = junctions.filter((j) => j.poNumber === po).map((j) => {
    const s = idx.shipById.get(j.shipmentId) || {};
    return { shipmentId: j.shipmentId, lotNumber: j.lotNumber, shipDate: s.shipDate, shippedPcs: shippedPcs(cartons, j.shipmentId, po) };
  });
  const irsForPo = receipts.filter((r) => r.poNumber === po).map((r) => ({
    receiptId: r.id, netsuiteIrId: r.netsuiteIrId, netsuiteIrTranid: r.netsuiteIrTranid || null,
    receiptDate: r.receiptDate, qty: idx.qtyByReceipt[r.id] || 0, matchedShipmentId: r.matchedShipmentId || null,
  }));

  const assignments = [];
  const lockedIr = new Set(), lockedShip = new Set();
  for (const r of irsForPo) {
    const ship = r.matchedShipmentId && shipsForPo.find((s) => s.shipmentId === r.matchedShipmentId);
    if (!ship) continue;
    assignments.push({ shipmentId: ship.shipmentId, receiptId: r.receiptId, netsuiteIrId: r.netsuiteIrId,
      netsuiteIrTranid: r.netsuiteIrTranid, receiptDate: r.receiptDate,
      shippedPcs: ship.shippedPcs, receiptQty: r.qty, method: 'confirmed', confidence: 'high', confirmed: true });
    lockedIr.add(r.receiptId); lockedShip.add(ship.shipmentId);
  }
  const freeShips = shipsForPo.filter((s) => !lockedShip.has(s.shipmentId));
  const freeIrs = irsForPo.filter((r) => !lockedIr.has(r.receiptId));
  for (const a of matchPo(freeShips, freeIrs, idx.isRejected)) assignments.push({ ...a, confirmed: false });
  return assignments;
}

// Resolve, for ONE shipment, the target IR of each of its POs.
// returns: [{ poNumber, target: {shipmentId, receiptId, netsuiteIrId, shippedPcs,
//             receiptQty, method, confidence, confirmed} | null }]
function resolveForShipment(shipmentId, poNumbers, data) {
  const idx = _index(data);
  return poNumbers.map((po) => ({
    poNumber: po,
    target: assignmentsForPo(po, data, idx).find((a) => a.shipmentId === shipmentId) || null,
  }));
}

// Which consignments have been RECEIVED IN NETSUITE — i.e. EVERY PO in the box has
// an Item Receipt attributed to THIS lot (same attribution the Landed Costs page
// shows and lets you correct, so status and landed cost can never disagree). A box
// whose second PO has no IR yet is NOT received: the consignment is one physical
// unit, so it is received only once all of it is.
//   Map(shipmentId → { receiptDate, ir_tranids, confirmed })
// receiptDate = the LATEST of its IR dates (the date the box was fully received).
// Drives the derived 'Received' status — see smsService.deriveStatus.
function receivedByShipment(data) {
  const { junctions = [] } = data;
  const idx = _index(data);
  const perPo = new Map();
  const posByShipment = new Map();
  for (const j of junctions) {
    if (!perPo.has(j.poNumber)) perPo.set(j.poNumber, assignmentsForPo(j.poNumber, data, idx));
    if (!posByShipment.has(j.shipmentId)) posByShipment.set(j.shipmentId, new Set());
    posByShipment.get(j.shipmentId).add(j.poNumber);
  }

  const out = new Map();
  for (const [shipmentId, pos] of posByShipment) {
    const targets = [...pos].map((po) => (perPo.get(po) || []).find((a) => a.shipmentId === shipmentId));
    if (!targets.length || !targets.every((t) => t && t.receiptId)) continue;
    const dates = targets.map((t) => t.receiptDate).filter(Boolean).sort();
    out.set(shipmentId, {
      receiptDate: dates.length ? dates[dates.length - 1] : null,
      ir_tranids: targets.map((t) => t.netsuiteIrTranid || (t.netsuiteIrId ? `#${t.netsuiteIrId}` : null)).filter(Boolean),
      confirmed: targets.every((t) => t.confirmed),
    });
  }
  return out;
}

module.exports = { matchPo, resolveForShipment, receivedByShipment, assignmentsForPo, shippedPcs };
