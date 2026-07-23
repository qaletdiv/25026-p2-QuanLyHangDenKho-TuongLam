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
//
// PURE — no IO. Confidence lets the preview flag weak (sequence, qty-mismatch) links.

// shipments: [{ shipment_id, lot_number, ship_date, shipped_pcs }]
// irs:       [{ receipt_id, netsuite_ir_id, receipt_date, qty }]
function matchPo(shipments = [], irs = []) {
  const ships = [...shipments].sort((a, b) =>
    (Number(a.lot_number) || 0) - (Number(b.lot_number) || 0)
    || String(a.ship_date || '').localeCompare(String(b.ship_date || '')));
  const pool = [...irs].sort((a, b) =>
    String(a.receipt_date || '').localeCompare(String(b.receipt_date || ''))
    || String(a.netsuite_ir_id || '').localeCompare(String(b.netsuite_ir_id || '')));

  const used = new Set();
  const out = ships.map((s) => ({ shipment_id: s.shipment_id, shipped_pcs: s.shipped_pcs, _pending: true }));

  // pass 1 — exact quantity (earliest unused IR with equal received qty)
  for (const row of out) {
    const hit = pool.find((r) => !used.has(r.receipt_id) && Number(r.qty) === Number(row.shipped_pcs));
    if (!hit) continue;
    used.add(hit.receipt_id);
    Object.assign(row, {
      receipt_id: hit.receipt_id, netsuite_ir_id: hit.netsuite_ir_id, netsuite_ir_tranid: hit.netsuite_ir_tranid,
      receipt_date: hit.receipt_date, receipt_qty: hit.qty,
      method: 'quantity', confidence: 'high', _pending: false,
    });
  }

  // pass 2 — sequence for the leftovers
  const leftover = pool.filter((r) => !used.has(r.receipt_id));
  let k = 0;
  for (const row of out) {
    if (!row._pending) { delete row._pending; continue; }
    const r = leftover[k++];
    if (r) {
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

// Resolve, for ONE shipment, the target IR of each of its POs. Confirmed matches
// (IR.matched_shipment_id) lock first; the remainder auto-matches via matchPo.
// data: { junctions, cartons, receipts, receiptLines, shipments }
// returns: [{ po_number, target: {shipment_id, receipt_id, netsuite_ir_id, shipped_pcs,
//             receipt_qty, method, confidence, confirmed} | null }]
function resolveForShipment(shipmentId, poNumbers, data) {
  const { junctions, cartons, receipts, receiptLines, shipments } = data;
  const shipById = new Map(shipments.map((s) => [s.id, s]));
  const qtyByReceipt = receiptLines.reduce((m, l) => ((m[l.receipt_id] = (m[l.receipt_id] || 0) + (Number(l.qty) || 0)), m), {});

  return poNumbers.map((po) => {
    const shipsForPo = junctions.filter((j) => j.po_number === po).map((j) => {
      const s = shipById.get(j.shipment_id) || {};
      return { shipment_id: j.shipment_id, lot_number: j.lot_number, ship_date: s.ship_date, shipped_pcs: shippedPcs(cartons, j.shipment_id, po) };
    });
    const irsForPo = receipts.filter((r) => r.po_number === po).map((r) => ({
      receipt_id: r.id, netsuite_ir_id: r.netsuite_ir_id, netsuite_ir_tranid: r.netsuite_ir_tranid || null,
      receipt_date: r.receipt_date, qty: qtyByReceipt[r.id] || 0, matched_shipment_id: r.matched_shipment_id || null,
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
    for (const a of matchPo(freeShips, freeIrs)) assignments.push({ ...a, confirmed: false });

    return { po_number: po, target: assignments.find((a) => a.shipment_id === shipmentId) || null };
  });
}

module.exports = { matchPo, resolveForShipment, shippedPcs };
