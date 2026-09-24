'use strict';

// Which NetSuite Item Receipt received a given mainline shipment's PO?
//
// ONE resolver, TWO consumers — and that is the whole point of this file. It used
// to live inside landedCostController while mainlineShipmentService derived ATA
// with its own date-FIFO allocation, so the portal held two different answers to
// "which IR belongs to this shipment". They disagreed on 12 of 17 shipment-legs.
// Worst case was SHP-7: FIFO consumed PO04770's OLDEST receipt (mir_35, 3,132 units
// on 2026-06-26) because it alone covered the leg's 1,271 units, stamping an ATA
// of 2026-06-26 — twelve days BEFORE that vessel reached the destination port.
// The Landed Costs page, matching on quantity, correctly picked mir_84 (exactly
// 1,271 units, 2026-08-04). FIFO asks "when did enough units arrive for this PO",
// which is not the same question as "which receipt is this consignment's".
//
// Model (confirmed with Lam 2026-07-22, same as SMS): ONE shipment ↔ ONE IR per PO.
// Signal hierarchy, via the shared pure `matchPo`:
//   1. human confirmation (mainline_item_receipts.matchedShipmentId) — locks first
//   2. quantity — an IR whose received qty equals the qty this shipment carries
//   3. sequence — leftovers paired positionally (order carries the signal, not dates)
// A human REJECTION (mainline_receipt_match_rejections) excludes the pair from both
// auto passes so the next-best candidate surfaces.
//
// ⚠️ `shipDate` below reads the shipment's RAW STORED `ata` column, never the
// derived one. enrichShipments now sets its ATA *from this resolver*, so feeding it
// a derived ATA back would close a loop: matcher → ATA → matcher. Keep this reading
// raw rows. It is only a sort key for the sequence pass, so the fallback to etaPod
// is sufficient (the stored ata is null on all but hand-entered shipments).

const { matchPo } = require('../../sms/receiptMatch');   // pure helper, no SMS writes

// Resolve the target IR per PO for ONE mainline shipment.
//
// ctx: { mlReceipts, mlReceiptLines, mlShipmentLegs, mlShipments, poByLeg, mlRejections }
// returns: [{ poNumber, receiptId, netsuiteIrId, netsuiteIrTranid, receiptDate,
//             receiptQty, method, confidence, confirmed, ambiguous }]
function resolveMainlineReceipts(shipmentId, poNumbers, c) {
  const { mlReceipts: receipts, mlReceiptLines: receiptLines, mlShipmentLegs: shipmentLegs, mlShipments: shipments, poByLeg } = c;
  const qtyByReceipt = receiptLines.reduce((m, l) => ((m[l.receiptId] = (m[l.receiptId] || 0) + (Number(l.qty) || 0)), m), {});
  const shipById = new Map(shipments.map((s) => [s.id, s]));
  // pairs a human explicitly rejected — excluded from the auto-match so the next
  // candidate surfaces instead (a confirmation on the pair clears the rejection)
  const rejectedSet = new Set((c.mlRejections || []).map((r) => `${r.receiptId}|${r.shipmentId}`));
  const isRejected = (shipmentId, receiptId) => rejectedSet.has(`${receiptId}|${shipmentId}`);

  return poNumbers.map((po) => {
    // every mainline shipment carrying this PO, with the qty that shipment carries
    const shipsForPo = shipmentLegs.filter((j) => poByLeg.get(j.legId) === po).map((j) => {
      const s = shipById.get(j.shipmentId) || {};
      return { shipmentId: j.shipmentId, lotNumber: j.lotNumber, shipDate: s.ata || s.etaPod || null, shippedPcs: Number(j.expectedQuantity) || 0 };
    });
    const irsForPo = receipts.filter((r) => r.poNumber === po).map((r) => ({
      receiptId: r.id, netsuiteIrId: r.netsuiteIrId, netsuiteIrTranid: r.netsuiteIrTranid || null,
      receiptDate: r.receiptDate, qty: qtyByReceipt[r.id] || 0, matchedShipmentId: r.matchedShipmentId || null,
    }));

    // confirmed matches lock first, then quantity/sequence auto-match the rest
    const assignments = [];
    const lockedIr = new Set(), lockedShip = new Set();
    for (const r of irsForPo) {
      const ship = r.matchedShipmentId && shipsForPo.find((s) => s.shipmentId === r.matchedShipmentId);
      if (!ship) continue;
      assignments.push({ shipmentId: ship.shipmentId, receiptId: r.receiptId, netsuiteIrId: r.netsuiteIrId,
        netsuiteIrTranid: r.netsuiteIrTranid, receiptDate: r.receiptDate, shippedPcs: ship.shippedPcs,
        receiptQty: r.qty, method: 'confirmed', confidence: 'high', confirmed: true });
      lockedIr.add(r.receiptId); lockedShip.add(ship.shipmentId);
    }
    const freeShips = shipsForPo.filter((s) => !lockedShip.has(s.shipmentId));
    const freeIrs = irsForPo.filter((r) => !lockedIr.has(r.receiptId));
    for (const a of matchPo(freeShips, freeIrs, isRejected)) assignments.push({ ...a, confirmed: false });

    const t = assignments.find((a) => a.shipmentId === shipmentId) || null;
    return {
      poNumber: po,
      receiptId: t ? t.receiptId : null,
      netsuiteIrId: t ? t.netsuiteIrId : null,
      netsuiteIrTranid: t ? t.netsuiteIrTranid : null,
      receiptDate: t ? t.receiptDate : null,
      receiptQty: t ? t.receiptQty : null,
      method: t ? t.method : 'unmatched',
      confidence: t ? t.confidence : 'low',
      confirmed: !!(t && t.confirmed),
      ambiguous: irsForPo.length > 1 && !(t && t.confirmed),
    };
  });
}

// ATA per shipment, for enrichShipments. Same resolver as above, run once over the
// whole table rather than per shipment: the matcher is PO-scoped and competitive
// (an IR consumed by one consignment is unavailable to the next), so every shipment
// carrying a PO must be resolved together — which resolveMainlineReceipts already
// does internally for each PO it is handed.
//
// A shipment's ATA = the LATEST of its POs' receipt dates: the consignment is one
// physical unit and is not fully received until all of its POs are. (Same rule as
// SMS `receivedByShipment`. The old FIFO took the EARLIEST across legs, which let a
// single mis-resolved leg drag the whole shipment's ATA backwards.)
//   Map(shipmentId → { date, method, confirmed })
function ataByShipment(c) {
  const { mlShipments: shipments, mlShipmentLegs: shipmentLegs, poByLeg } = c;
  const out = new Map();
  for (const s of shipments) {
    const pos = [...new Set(shipmentLegs.filter((j) => j.shipmentId === s.id)
      .map((j) => poByLeg.get(j.legId)).filter(Boolean))];
    if (!pos.length) continue;
    const targets = resolveMainlineReceipts(s.id, pos, c);
    // Every PO must have a receipt — a part-received consignment has no arrival date
    // yet, and inventing one from the POs that did land would overstate arrival.
    if (!targets.every((t) => t && t.receiptId && t.receiptDate)) continue;
    const dates = targets.map((t) => t.receiptDate).sort();
    out.set(s.id, {
      date: dates[dates.length - 1],
      method: targets.some((t) => t.method === 'sequence') ? 'sequence' : targets[0].method,
      confirmed: targets.every((t) => t.confirmed),
    });
  }
  return out;
}

module.exports = { resolveMainlineReceipts, ataByShipment };
