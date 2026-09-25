'use strict';

// SMS Item Receipt matching — confirm which SHIPMENT (lot) an Item Receipt
// received. This is the human sign-off on the auto-suggested match (receiptMatch
// .matchPo, quantity → sequence) and is what lets the landed-cost push target the
// correct IR when a PO has several receipts. Writes ONLY the portal-owned
// confirmation columns on sms_item_receipts (matchedShipmentId / confirmed_*);
// NetSuite-owned IR facts are never touched (the sync preserves these on re-sync).

const M = require('./SmsModels');
const { resolveForShipment } = require('./receiptMatch');
const { assertShipmentVisible } = require('./vendorAccess');

const { notifyChange } = require('../notifications/emailNotifier');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

// Mirror of mainlineReceiptController._notifyMatch. Same rule: the email goes out
// when someone ASSERTS or WITHDRAWS an attribution, not when a rejection is undone
// (that asserts nothing — it only re-opens the candidate to the matcher).
//
// The supplier comes from the POs in the box and is NULL when the box spans more
// than one — the same `every` rule vendorAccess applies to reads, so a mixed
// consignment never puts one supplier's PO numbers in another supplier's inbox.
async function _notifyMatch(req, r, shipmentId, action) {
  const [shipments, junctions, pos] = await Promise.all([
    M.shipments.read().catch(() => []),
    M.shipmentPos.read().catch(() => []),
    M.pos.read().catch(() => []),
  ]);
  const ship = shipments.find((x) => x.id === shipmentId);
  const poBy = new Map(pos.map((x) => [x.poNumber, x]));
  const sids = [...new Set(junctions.filter((j) => j.shipmentId === shipmentId)
    .map((j) => (poBy.get(j.poNumber) || {}).supplierId || null))];
  await notifyChange({
    module: 'sms', entity: 'sms_receipt', entityId: r.id,
    ref: r.netsuiteIrTranid || r.netsuiteIrId || r.id,
    action: `${action} ${ship ? (ship.trackingNumber || shipmentId) : shipmentId}`,
    context: [
      { label: 'PO', value: r.poNumber || '—' },
      { label: 'Receipt date', value: r.receiptDate ? String(r.receiptDate).slice(0, 10) : '—' },
    ],
    supplierId: sids.length === 1 ? sids[0] : null,
    actor: req.user,
    link: ship ? `/sms/shipments/${ship.id}` : null,
  });
}

// Drop any rejection of this (receipt, shipment) pair — confirming the pair is the
// opposite assertion, so the two can never both stand. Also the undo path: re-adding
// the IR by hand un-rejects it. Returns the surviving rows (caller writes once).
const withoutRejection = (rejections, receiptId, shipmentId) =>
  rejections.filter((x) => !(x.receiptId === receiptId && x.shipmentId === shipmentId));

// GET /sms/shipments/:id/receipt-matches — the suggested (or confirmed) IR per PO
// for a shipment. Read-only; drives a confirm UI and lets you inspect a match.
async function suggestForShipment(req, res) {
  await assertShipmentVisible(req, req.params.id);
  const [shipments, shipmentPos, cartons, receipts, receiptLines, rejections] = await Promise.all([
    M.shipments.read(), M.shipmentPos.read(), M.packingCartons.read().catch(() => []),
    M.receipts.read().catch(() => []), M.receiptLines.read().catch(() => []),
    M.receiptRejections.read().catch(() => []),
  ]);
  const s = shipments.find((x) => x.id === req.params.id);
  if (!s) err('SMS shipment not found', 404);
  const poNumbers = [...new Set(shipmentPos.filter((j) => j.shipmentId === s.id).map((j) => j.poNumber))];
  const resolved = resolveForShipment(s.id, poNumbers, { junctions: shipmentPos, cartons, receipts, receiptLines, shipments, rejections });
  res.json({ shipmentId: s.id, matches: resolved });
}

// POST /sms/receipts/:id/match { shipmentId } — confirm the match.
async function setMatch(req, res) {
  const { shipmentId } = req.body;
  const [receipts, shipmentPos, rejections] = await Promise.all([
    M.receipts.read(), M.shipmentPos.read(), M.receiptRejections.read().catch(() => []),
  ]);
  const r = receipts.find((x) => x.id === req.params.id);
  if (!r) err('Item receipt not found', 404);
  // the shipment must actually carry this receipt's PO
  if (!shipmentPos.some((j) => j.shipmentId === shipmentId && j.poNumber === r.poNumber)) {
    err(`Shipment ${shipmentId} does not carry PO ${r.poNumber}`, 400);
  }
  r.matchedShipmentId = shipmentId;
  r.confirmedBy = req.user?.id || null;
  r.confirmedAt = new Date().toISOString();
  await M.receipts.write(receipts);
  const kept = withoutRejection(rejections, r.id, shipmentId);
  if (kept.length !== rejections.length) await M.receiptRejections.write(kept);
  await _notifyMatch(req, r, shipmentId, 'was CONFIRMED against');
  res.json(r);
}

// POST /sms/receipts/:id/reject { shipmentId } — the human says this suggested IR
// is NOT the one that received this lot. Stored (the match is derived per read, so
// an unstored "no" would come straight back); the matcher then offers the next
// candidate, or falls through to the manual IR-# entry when there is none.
async function rejectMatch(req, res) {
  const { shipmentId } = req.body;
  const [receipts, shipmentPos, rejections] = await Promise.all([
    M.receipts.read(), M.shipmentPos.read(), M.receiptRejections.read().catch(() => []),
  ]);
  const r = receipts.find((x) => x.id === req.params.id);
  if (!r) err('Item receipt not found', 404);
  if (!shipmentPos.some((j) => j.shipmentId === shipmentId && j.poNumber === r.poNumber)) {
    err(`Shipment ${shipmentId} does not carry PO ${r.poNumber}`, 400);
  }
  // rejecting a pair that is currently CONFIRMED also withdraws the confirmation
  if (r.matchedShipmentId === shipmentId) {
    r.matchedShipmentId = null; r.confirmedBy = null; r.confirmedAt = null;
    await M.receipts.write(receipts);
  }
  if (!rejections.some((x) => x.receiptId === r.id && x.shipmentId === shipmentId)) {
    const seq = rejections.reduce((mx, x) => Math.max(mx, +String(x.id).replace(/\D/g, '') || 0), 0) + 1;
    rejections.push({ id: `srej_${seq}`, receiptId: r.id, shipmentId,
      rejectedBy: req.user?.id || null, rejectedAt: new Date().toISOString() });
    await M.receiptRejections.write(rejections);
  }
  await _notifyMatch(req, r, shipmentId, 'was REJECTED as the receipt for');
  res.json({ receiptId: r.id, shipmentId, rejected: true });
}

// DELETE /sms/receipts/:id/reject { shipmentId } — undo a rejection (the pair
// becomes auto-matchable again). Confirming or manually re-adding the IR does this
// implicitly; this is the explicit "I clicked ✗ by mistake" path.
async function unrejectMatch(req, res) {
  const shipmentId = req.body?.shipmentId || req.query.shipmentId;
  if (!shipmentId) err("'shipmentId' is required", 400);
  const rejections = await M.receiptRejections.read().catch(() => []);
  const kept = withoutRejection(rejections, req.params.id, shipmentId);
  if (kept.length !== rejections.length) await M.receiptRejections.write(kept);
  res.json({ receiptId: req.params.id, shipmentId, rejected: false });
}

// POST /sms/receipts/manual-match { shipmentId, poNumber, ir_tranid } — when the
// auto-matcher found no Item Receipt, let the user type the IR document number
// (e.g. IR65377). Resolves it to an existing synced receipt for that PO, else looks
// it up in NetSuite (tranid → internal id) and creates a MANUAL matched receipt row
// so the landed-cost push has a target. The internal id is what the push PATCHes.
async function manualMatch(req, res) {
  const { shipmentId, poNumber, ir_tranid } = req.body;
  const [receipts, shipmentPos, rejections] = await Promise.all([
    M.receipts.read(), M.shipmentPos.read(), M.receiptRejections.read().catch(() => []),
  ]);
  if (!shipmentPos.some((j) => j.shipmentId === shipmentId && j.poNumber === poNumber)) {
    err(`Shipment ${shipmentId} does not carry PO ${poNumber}`, 400);
  }
  const norm = (x) => String(x || '').trim().toUpperCase();

  // 1) already synced for this PO under that document number?
  let r = receipts.find((x) => x.poNumber === poNumber && norm(x.netsuiteIrTranid) === norm(ir_tranid));
  if (!r) {
    // 2) resolve the internal id from NetSuite
    const ir = await require('../../services/integrationService').fetchItemReceiptByTranid(ir_tranid).catch(() => null);
    if (!ir) err(`Item Receipt "${ir_tranid}" not found in NetSuite`, 404);
    // reuse a row if that internal id is already stored (any PO), else create a manual one
    r = receipts.find((x) => String(x.netsuiteIrId) === String(ir.ir_id));
    if (!r) {
      const seq = receipts.reduce((mx, x) => Math.max(mx, +String(x.id).replace(/\D/g, '') || 0), 0) + 1;
      r = { id: `sir_${seq}`, netsuiteIrId: ir.ir_id, netsuiteIrTranid: ir.ir_tranid, poNumber,
        receiptDate: ir.receiptDate, source: 'manual', matchedShipmentId: null, confirmedBy: null, confirmedAt: null };
      receipts.push(r);
    }
  }
  r.matchedShipmentId = shipmentId;
  r.confirmedBy = req.user?.id || null;
  r.confirmedAt = new Date().toISOString();
  await M.receipts.write(receipts);
  const kept = withoutRejection(rejections, r.id, shipmentId);
  if (kept.length !== rejections.length) await M.receiptRejections.write(kept);
  await _notifyMatch(req, r, shipmentId, 'was MANUALLY MATCHED to');
  res.json(r);
}

// DELETE /sms/receipts/:id/match — clear a confirmed match.
async function clearMatch(req, res) {
  const receipts = await M.receipts.read();
  const r = receipts.find((x) => x.id === req.params.id);
  if (!r) err('Item receipt not found', 404);
  // captured before it is nulled — the only useful part of the message is which
  // consignment the receipt was detached FROM
  const was = r.matchedShipmentId;
  r.matchedShipmentId = null;
  r.confirmedBy = null;
  r.confirmedAt = null;
  await M.receipts.write(receipts);
  if (was) await _notifyMatch(req, r, was, 'was UNMATCHED from');
  res.json(r);
}

module.exports = { suggestForShipment, setMatch, clearMatch, manualMatch, rejectMatch, unrejectMatch };
