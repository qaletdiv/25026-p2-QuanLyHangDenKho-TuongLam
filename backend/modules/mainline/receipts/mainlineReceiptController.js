'use strict';

// Mainline Item Receipt matching — confirm which shipment's landed cost posts to a
// given Item Receipt (that PO's freight/duty share). Simpler than SMS: a receipt
// attaches to a poNumber, and "which shipment the receipt came from doesn't
// matter" (Lam), so a PO is just matched to one of its IRs. Writes ONLY the
// portal-owned columns on mainline_item_receipts (matchedShipmentId/confirmed_*);
// NetSuite facts are preserved by the sync.

const { models } = require('../../../models');
const shipmentLegs = models.mainline_shipment_legs;
const legs = models.mainline_po_legs;

const { notifyChange } = require('../../notifications/emailNotifier');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

// Report a change of Item-Receipt ATTRIBUTION — the decision that makes a
// consignment Received, and therefore postable to NetSuite. It is money-adjacent,
// which is why it is mailed at all.
//
// Deliberately NOT called from `unrejectMatch`: removing a rejection asserts
// nothing, it just lets the matcher offer that candidate again. The email goes
// out when someone actually says yes or no.
async function _notifyMatch(req, r, shipmentId, action) {
  const [shipments, bookings] = await Promise.all([
    models.mainline_shipments.read().catch(() => []),
    models.mainline_bookings.read().catch(() => []),
  ]);
  const ship = shipments.find((s) => s.id === shipmentId);
  const booking = ship ? bookings.find((b) => b.id === ship.bookingId) : null;
  await notifyChange({
    module: 'mainline', entity: 'mainline_receipt', entityId: r.id,
    ref: r.netsuiteIrTranid || r.netsuiteIrId || r.id,
    action: `${action} ${ship ? (ship.shipmentNumber || shipmentId) : shipmentId}`,
    context: [
      { label: 'PO', value: r.poNumber || '—' },
      { label: 'Receipt date', value: r.receiptDate ? String(r.receiptDate).slice(0, 10) : '—' },
    ],
    supplierId: booking ? booking.supplierId || null : null,
    actor: req.user,
    link: ship ? `/mainline/shipments/${ship.id}` : null,
  });
}

// The set of poNumbers a shipment carries (via its legs).
async function _shipmentPos(shipmentId) {
  const [sl, lg] = await Promise.all([shipmentLegs.read(), legs.read()]);
  const legIds = new Set(sl.filter((x) => x.shipmentId === shipmentId).map((x) => x.legId));
  return new Set(lg.filter((l) => legIds.has(l.id)).map((l) => l.poNumber));
}

// Drop any rejection of this (receipt, shipment) pair — confirming it is the
// opposite assertion, so both can never stand. Also the undo path: re-adding the IR
// by hand un-rejects it. Returns the surviving rows (caller writes once).
const withoutRejection = (rejections, receiptId, shipmentId) =>
  rejections.filter((x) => !(x.receiptId === receiptId && x.shipmentId === shipmentId));

// keep at most ONE confirmed IR per (shipment, PO)
function unmatchSiblings(receipts, r, shipmentId) {
  receipts.forEach((x) => {
    if (x.id !== r.id && x.poNumber === r.poNumber && x.matchedShipmentId === shipmentId) {
      x.matchedShipmentId = null; x.confirmedBy = null; x.confirmedAt = null;
    }
  });
}

// POST /mainline/receipts/:id/match { shipmentId }
async function setMatch(req, res) {
  const { shipmentId } = req.body || {};
  if (!shipmentId) err("'shipmentId' is required", 400);
  const receipts = await models.mainline_item_receipts.read();
  const r = receipts.find((x) => x.id === req.params.id);
  if (!r) err('Item receipt not found', 404);
  if (!(await _shipmentPos(shipmentId)).has(r.poNumber)) err(`Shipment ${shipmentId} does not carry PO ${r.poNumber}`, 400);
  unmatchSiblings(receipts, r, shipmentId);
  r.matchedShipmentId = shipmentId;
  r.confirmedBy = req.user?.id || null;
  r.confirmedAt = new Date().toISOString();
  await models.mainline_item_receipts.write(receipts);
  const rejections = await models.mainline_receipt_match_rejections.read().catch(() => []);
  const kept = withoutRejection(rejections, r.id, shipmentId);
  if (kept.length !== rejections.length) await models.mainline_receipt_match_rejections.write(kept);
  await _notifyMatch(req, r, shipmentId, 'was CONFIRMED against');
  res.json(r);
}

// POST /mainline/receipts/:id/reject { shipmentId } — the human says this suggested
// IR is NOT the one for this shipment's PO. Stored, because the match is derived per
// read: an unstored "no" would be re-suggested on the next refresh. The matcher then
// offers the next candidate, or falls through to manual IR-# entry.
async function rejectMatch(req, res) {
  const { shipmentId } = req.body || {};
  if (!shipmentId) err("'shipmentId' is required", 400);
  const receipts = await models.mainline_item_receipts.read();
  const r = receipts.find((x) => x.id === req.params.id);
  if (!r) err('Item receipt not found', 404);
  if (!(await _shipmentPos(shipmentId)).has(r.poNumber)) err(`Shipment ${shipmentId} does not carry PO ${r.poNumber}`, 400);
  // rejecting a pair that is currently CONFIRMED also withdraws the confirmation
  if (r.matchedShipmentId === shipmentId) {
    r.matchedShipmentId = null; r.confirmedBy = null; r.confirmedAt = null;
    await models.mainline_item_receipts.write(receipts);
  }
  const rejections = await models.mainline_receipt_match_rejections.read().catch(() => []);
  if (!rejections.some((x) => x.receiptId === r.id && x.shipmentId === shipmentId)) {
    const seq = rejections.reduce((mx, x) => Math.max(mx, +String(x.id).replace(/\D/g, '') || 0), 0) + 1;
    rejections.push({ id: `mrej_${seq}`, receiptId: r.id, shipmentId,
      rejectedBy: req.user?.id || null, rejectedAt: new Date().toISOString() });
    await models.mainline_receipt_match_rejections.write(rejections);
  }
  await _notifyMatch(req, r, shipmentId, 'was REJECTED as the receipt for');
  res.json({ receiptId: r.id, shipmentId, rejected: true });
}

// DELETE /mainline/receipts/:id/reject?shipmentId=… — undo a rejection.
async function unrejectMatch(req, res) {
  const shipmentId = req.body?.shipmentId || req.query.shipmentId;
  if (!shipmentId) err("'shipmentId' is required", 400);
  const rejections = await models.mainline_receipt_match_rejections.read().catch(() => []);
  const kept = withoutRejection(rejections, req.params.id, shipmentId);
  if (kept.length !== rejections.length) await models.mainline_receipt_match_rejections.write(kept);
  res.json({ receiptId: req.params.id, shipmentId, rejected: false });
}

// DELETE /mainline/receipts/:id/match
async function clearMatch(req, res) {
  const receipts = await models.mainline_item_receipts.read();
  const r = receipts.find((x) => x.id === req.params.id);
  if (!r) err('Item receipt not found', 404);
  // read the link before it is nulled — otherwise the email cannot say what the
  // receipt was detached FROM, which is the only useful part of the message
  const was = r.matchedShipmentId;
  r.matchedShipmentId = null; r.confirmedBy = null; r.confirmedAt = null;
  await models.mainline_item_receipts.write(receipts);
  if (was) await _notifyMatch(req, r, was, 'was UNMATCHED from');
  res.json(r);
}

// POST /mainline/receipts/manual-match { shipmentId, poNumber, ir_tranid }
async function manualMatch(req, res) {
  const { shipmentId, poNumber, ir_tranid } = req.body || {};
  if (!shipmentId || !poNumber || !ir_tranid) err("'shipmentId', 'poNumber' and 'ir_tranid' are required", 400);
  if (!(await _shipmentPos(shipmentId)).has(poNumber)) err(`Shipment ${shipmentId} does not carry PO ${poNumber}`, 400);

  const receipts = await models.mainline_item_receipts.read();
  const norm = (x) => String(x || '').trim().toUpperCase();
  let r = receipts.find((x) => x.poNumber === poNumber && norm(x.netsuiteIrTranid) === norm(ir_tranid));
  if (!r) {
    const ir = await require('../../../services/integrationService').fetchItemReceiptByTranid(ir_tranid).catch(() => null);
    if (!ir) err(`Item Receipt "${ir_tranid}" not found in NetSuite`, 404);
    r = receipts.find((x) => String(x.netsuiteIrId) === String(ir.ir_id));
    if (!r) {
      const seq = receipts.reduce((mx, x) => Math.max(mx, +String(x.id).replace(/\D/g, '') || 0), 0) + 1;
      r = { id: `mir_${seq}`, netsuiteIrId: ir.ir_id, netsuiteIrTranid: ir.ir_tranid, poNumber,
        receiptDate: ir.receiptDate, source: 'manual', matchedShipmentId: null, confirmedBy: null, confirmedAt: null };
      receipts.push(r);
    }
  }
  unmatchSiblings(receipts, r, shipmentId);
  r.matchedShipmentId = shipmentId;
  r.confirmedBy = req.user?.id || null;
  r.confirmedAt = new Date().toISOString();
  await models.mainline_item_receipts.write(receipts);
  const rejections = await models.mainline_receipt_match_rejections.read().catch(() => []);
  const kept = withoutRejection(rejections, r.id, shipmentId);
  if (kept.length !== rejections.length) await models.mainline_receipt_match_rejections.write(kept);
  await _notifyMatch(req, r, shipmentId, 'was MANUALLY MATCHED to');
  res.json(r);
}

module.exports = { setMatch, clearMatch, manualMatch, rejectMatch, unrejectMatch };
