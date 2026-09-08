'use strict';

// Match an SMS shipment (one lot handed to the courier) to the NetSuite Item
// Receipt that received it — the link landed-cost push needs to target the right
// IR. Model (confirmed with Lam 2026-07-22): ONE shipment ↔ ONE IR per PO. When a
// PO ships in several lots, each lot's landed cost attaches to its own IR.
//
// Dates are NEVER matched for equality: courier + receiving lag makes the IR's
// receipt_date drift before/after the ship_date (real case: PO04821 ship 2026-07-22
// vs receipt 2026-07-21). So the signal hierarchy is:
//   1. quantity — an IR whose received qty equals the shipment's shipped pcs.
//   2. sequence — leftover shipments (ordered by lot, then ship_date) paired
//                 positionally with leftover IRs (ordered by receipt_date, then
//                 netsuite_ir_id). Order, not date value, carries the signal.
// A human confirmation (sms_item_receipts.matched_shipment_id) overrides both.
// A human REJECTION (sms_receipt_match_rejections) is the negative of that: the
// pair is excluded from BOTH passes, so the next-best candidate surfaces instead
// of the suggestion the user already said no to. Without it, rejecting could only
// ever be cosmetic — the matcher is derived per read and would re-suggest it.
//
// PURE — no IO. Confidence lets the preview flag weak (sequence, qty-mismatch) links.

// shipments: [{ shipment_id, lot_number, ship_date, shipped_pcs }]
// irs:       [{ receipt_id, netsuite_ir_id, receipt_date, qty }]
// isRejected(shipment_id, receipt_id) -> bool  (default: nothing rejected)
function matchPo(shipments = [], irs = [], isRejected = () => false) {
  const ships = [...shipments].sort((a, b) =>
    (Number(a.lot_number) || 0) - (Number(b.lot_number) || 0)
    || String(a.ship_date || '').localeCompare(String(b.ship_date || '')));
  const pool = [...irs].sort((a, b) =>
    String(a.receipt_date || '').localeCompare(String(b.receipt_date || ''))
    || String(a.netsuite_ir_id || '').localeCompare(String(b.netsuite_ir_id || '')));

  const used = new Set();
  const out = ships.map((s) => ({ shipment_id: s.shipment_id, shipped_pcs: s.shipped_pcs, _pending: true }));

  const free = (r, shipmentId) => !used.has(r.receipt_id) && !isRejected(shipmentId, r.receipt_id);

  // pass 1 — exact quantity (earliest unused IR with equal received qty)
  for (const row of out) {
    const hit = pool.find((r) => free(r, row.shipment_id) && Number(r.qty) === Number(row.shipped_pcs));
    if (!hit) continue;
    used.add(hit.receipt_id);
    Object.assign(row, {
      receipt_id: hit.receipt_id, netsuite_ir_id: hit.netsuite_ir_id, netsuite_ir_tranid: hit.netsuite_ir_tranid,
      receipt_date: hit.receipt_date, receipt_qty: hit.qty,
      method: 'quantity', confidence: 'high', _pending: false,
    });
  }

  // pass 2 — sequence for the leftovers. "First still-free IR" rather than a
  // running index: with no rejections that IS the positional pairing (0,1,2…),
  // and a rejected pair simply falls through to the next candidate.
  const leftover = pool.filter((r) => !used.has(r.receipt_id));
  for (const row of out) {
    if (!row._pending) { delete row._pending; continue; }
    const r = leftover.find((x) => free(x, row.shipment_id));
    if (r) {
      used.add(r.receipt_id);
      Object.assign(row, {
        receipt_id: r.receipt_id, netsuite_ir_id: r.netsuite_ir_id, netsuite_ir_tranid: r.netsuite_ir_tranid,
        receipt_date: r.receipt_date, receipt_qty: r.qty,
        method: 'sequence',
        // agreeing quantity in the sequence pass still earns high confidence
        confidence: Number(r.qty) === Number(row.shipped_pcs) ? 'high' : 'medium',
      });
    } else {
      Object.assign(row, { receipt_id: null, netsuite_ir_id: null, netsuite_ir_tranid: null, receipt_date: null, receipt_qty: null, method: 'unmatched', confidence: 'low' });
    }
    delete row._pending;
  }
  return out;
}

// Σ shipped pcs for a (shipment, PO) from the uploaded packing cartons.
function shippedPcs(cartons, shipmentId, poNumber) {
  return cartons
    .filter((c) => c.shipment_id === shipmentId && c.po_number === poNumber)
    .reduce((a, c) => a + (Number(c.pcs_per_ctn) || 0), 0);
}

// Assignments for ONE PO — every shipment carrying it paired with its IR (or a
// null target). Confirmed matches (IR.matched_shipment_id) lock first; the
// remainder auto-matches via matchPo. `idx` is the shared lookup built by _index
// so callers resolving many POs don't rebuild it per PO.
// data: { junctions, cartons, receipts, receiptLines, shipments, rejections }
function _index({ shipments = [], receiptLines = [], rejections = [] }) {
  const rejected = new Set(rejections.map((r) => `${r.receipt_id}|${r.shipment_id}`));
  return {
    shipById: new Map(shipments.map((s) => [s.id, s])),
    qtyByReceipt: receiptLines.reduce((m, l) => ((m[l.receipt_id] = (m[l.receipt_id] || 0) + (Number(l.qty) || 0)), m), {}),
    isRejected: (shipmentId, receiptId) => rejected.has(`${receiptId}|${shipmentId}`),
  };
}

function assignmentsForPo(po, data, idx = _index(data)) {
  const { junctions, cartons, receipts } = data;
  const shipsForPo = junctions.filter((j) => j.po_number === po).map((j) => {
    const s = idx.shipById.get(j.shipment_id) || {};
    return { shipment_id: j.shipment_id, lot_number: j.lot_number, ship_date: s.ship_date, shipped_pcs: shippedPcs(cartons, j.shipment_id, po) };
  });
  const irsForPo = receipts.filter((r) => r.po_number === po).map((r) => ({
    receipt_id: r.id, netsuite_ir_id: r.netsuite_ir_id, netsuite_ir_tranid: r.netsuite_ir_tranid || null,
    receipt_date: r.receipt_date, qty: idx.qtyByReceipt[r.id] || 0, matched_shipment_id: r.matched_shipment_id || null,
  }));

  const assignments = [];
  const lockedIr = new Set(), lockedShip = new Set();
  for (const r of irsForPo) {
    const ship = r.matched_shipment_id && shipsForPo.find((s) => s.shipment_id === r.matched_shipment_id);
    if (!ship) continue;
    assignments.push({ shipment_id: ship.shipment_id, receipt_id: r.receipt_id, netsuite_ir_id: r.netsuite_ir_id,
      netsuite_ir_tranid: r.netsuite_ir_tranid, receipt_date: r.receipt_date,
      shipped_pcs: ship.shipped_pcs, receipt_qty: r.qty, method: 'confirmed', confidence: 'high', confirmed: true });
    lockedIr.add(r.receipt_id); lockedShip.add(ship.shipment_id);
  }
  const freeShips = shipsForPo.filter((s) => !lockedShip.has(s.shipment_id));
  const freeIrs = irsForPo.filter((r) => !lockedIr.has(r.receipt_id));
  for (const a of matchPo(freeShips, freeIrs, idx.isRejected)) assignments.push({ ...a, confirmed: false });
  return assignments;
}

// Resolve, for ONE shipment, the target IR of each of its POs.
// returns: [{ po_number, target: {shipment_id, receipt_id, netsuite_ir_id, shipped_pcs,
//             receipt_qty, method, confidence, confirmed} | null }]
function resolveForShipment(shipmentId, poNumbers, data) {
  const idx = _index(data);
  return poNumbers.map((po) => ({
    po_number: po,
    target: assignmentsForPo(po, data, idx).find((a) => a.shipment_id === shipmentId) || null,
  }));
}

// Which consignments have been RECEIVED IN NETSUITE — i.e. EVERY PO in the box has
// an Item Receipt attributed to THIS lot (same attribution the Landed Costs page
// shows and lets you correct, so status and landed cost can never disagree). A box
// whose second PO has no IR yet is NOT received: the consignment is one physical
// unit, so it is received only once all of it is.
//   Map(shipment_id → { receipt_date, ir_tranids, confirmed })
// receipt_date = the LATEST of its IR dates (the date the box was fully received).
// Drives the derived 'Received' status — see smsService.deriveStatus.
function receivedByShipment(data) {
  const { junctions = [] } = data;
  const idx = _index(data);
  const perPo = new Map();
  const posByShipment = new Map();
  for (const j of junctions) {
    if (!perPo.has(j.po_number)) perPo.set(j.po_number, assignmentsForPo(j.po_number, data, idx));
    if (!posByShipment.has(j.shipment_id)) posByShipment.set(j.shipment_id, new Set());
    posByShipment.get(j.shipment_id).add(j.po_number);
  }

  const out = new Map();
  for (const [shipmentId, pos] of posByShipment) {
    const targets = [...pos].map((po) => (perPo.get(po) || []).find((a) => a.shipment_id === shipmentId));
    if (!targets.length || !targets.every((t) => t && t.receipt_id)) continue;
    const dates = targets.map((t) => t.receipt_date).filter(Boolean).sort();
    out.set(shipmentId, {
      receipt_date: dates.length ? dates[dates.length - 1] : null,
      ir_tranids: targets.map((t) => t.netsuite_ir_tranid || (t.netsuite_ir_id ? `#${t.netsuite_ir_id}` : null)).filter(Boolean),
      confirmed: targets.every((t) => t.confirmed),
    });
  }
  return out;
}

module.exports = { matchPo, resolveForShipment, receivedByShipment, assignmentsForPo, shippedPcs };
