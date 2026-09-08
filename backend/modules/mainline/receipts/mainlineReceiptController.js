'use strict';

// Mainline Item Receipt matching — confirm which shipment's landed cost posts to a
// given Item Receipt (that PO's freight/duty share). Simpler than SMS: a receipt
// attaches to a po_number, and "which shipment the receipt came from doesn't
// matter" (Lam), so a PO is just matched to one of its IRs. Writes ONLY the
// portal-owned columns on mainline_item_receipts (matched_shipment_id/confirmed_*);
// NetSuite facts are preserved by the sync.

const M = require('./MainlineItemReceiptModel');
const BaseModel = require('../../../models/BaseModel');
const shipmentLegs = new BaseModel('migrated/mainline_shipment_legs.json');
const legs = new BaseModel('migrated/mainline_po_legs.json');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

// The set of po_numbers a shipment carries (via its legs).
async function _shipmentPos(shipmentId) {
  const [sl, lg] = await Promise.all([shipmentLegs.read(), legs.read()]);
  const legIds = new Set(sl.filter((x) => x.shipment_id === shipmentId).map((x) => x.leg_id));
  return new Set(lg.filter((l) => legIds.has(l.id)).map((l) => l.po_number));
}

// Drop any rejection of this (receipt, shipment) pair — confirming it is the
// opposite assertion, so both can never stand. Also the undo path: re-adding the IR
// by hand un-rejects it. Returns the surviving rows (caller writes once).
const withoutRejection = (rejections, receiptId, shipmentId) =>
  rejections.filter((x) => !(x.receipt_id === receiptId && x.shipment_id === shipmentId));

// keep at most ONE confirmed IR per (shipment, PO)
function unmatchSiblings(receipts, r, shipmentId) {
  receipts.forEach((x) => {
    if (x.id !== r.id && x.po_number === r.po_number && x.matched_shipment_id === shipmentId) {
      x.matched_shipment_id = null; x.confirmed_by = null; x.confirmed_at = null;
    }
  });
}

// POST /mainline/receipts/:id/match { shipment_id }
async function setMatch(req, res) {
  const { shipment_id } = req.body || {};
  if (!shipment_id) err("'shipment_id' is required", 400);
  const receipts = await M.readReceipts();
  const r = receipts.find((x) => x.id === req.params.id);
  if (!r) err('Item receipt not found', 404);
  if (!(await _shipmentPos(shipment_id)).has(r.po_number)) err(`Shipment ${shipment_id} does not carry PO ${r.po_number}`, 400);
  unmatchSiblings(receipts, r, shipment_id);
  r.matched_shipment_id = shipment_id;
  r.confirmed_by = req.user?.id || null;
  r.confirmed_at = new Date().toISOString();
  await M.writeReceipts(receipts);
  const rejections = await M.readRejections().catch(() => []);
  const kept = withoutRejection(rejections, r.id, shipment_id);
  if (kept.length !== rejections.length) await M.writeRejections(kept);
  res.json(r);
}

// POST /mainline/receipts/:id/reject { shipment_id } — the human says this suggested
// IR is NOT the one for this shipment's PO. Stored, because the match is derived per
// read: an unstored "no" would be re-suggested on the next refresh. The matcher then
// offers the next candidate, or falls through to manual IR-# entry.
async function rejectMatch(req, res) {
  const { shipment_id } = req.body || {};
  if (!shipment_id) err("'shipment_id' is required", 400);
  const receipts = await M.readReceipts();
  const r = receipts.find((x) => x.id === req.params.id);
  if (!r) err('Item receipt not found', 404);
  if (!(await _shipmentPos(shipment_id)).has(r.po_number)) err(`Shipment ${shipment_id} does not carry PO ${r.po_number}`, 400);
  // rejecting a pair that is currently CONFIRMED also withdraws the confirmation
  if (r.matched_shipment_id === shipment_id) {
    r.matched_shipment_id = null; r.confirmed_by = null; r.confirmed_at = null;
    await M.writeReceipts(receipts);
  }
  const rejections = await M.readRejections().catch(() => []);
  if (!rejections.some((x) => x.receipt_id === r.id && x.shipment_id === shipment_id)) {
    const seq = rejections.reduce((mx, x) => Math.max(mx, +String(x.id).replace(/\D/g, '') || 0), 0) + 1;
    rejections.push({ id: `mrej_${seq}`, receipt_id: r.id, shipment_id,
      rejected_by: req.user?.id || null, rejected_at: new Date().toISOString() });
    await M.writeRejections(rejections);
  }
  res.json({ receipt_id: r.id, shipment_id, rejected: true });
}

// DELETE /mainline/receipts/:id/reject?shipment_id=… — undo a rejection.
async function unrejectMatch(req, res) {
  const shipment_id = req.body?.shipment_id || req.query.shipment_id;
  if (!shipment_id) err("'shipment_id' is required", 400);
  const rejections = await M.readRejections().catch(() => []);
  const kept = withoutRejection(rejections, req.params.id, shipment_id);
  if (kept.length !== rejections.length) await M.writeRejections(kept);
  res.json({ receipt_id: req.params.id, shipment_id, rejected: false });
}

// DELETE /mainline/receipts/:id/match
async function clearMatch(req, res) {
  const receipts = await M.readReceipts();
  const r = receipts.find((x) => x.id === req.params.id);
  if (!r) err('Item receipt not found', 404);
  r.matched_shipment_id = null; r.confirmed_by = null; r.confirmed_at = null;
  await M.writeReceipts(receipts);
  res.json(r);
}

// POST /mainline/receipts/manual-match { shipment_id, po_number, ir_tranid }
async function manualMatch(req, res) {
  const { shipment_id, po_number, ir_tranid } = req.body || {};
  if (!shipment_id || !po_number || !ir_tranid) err("'shipment_id', 'po_number' and 'ir_tranid' are required", 400);
  if (!(await _shipmentPos(shipment_id)).has(po_number)) err(`Shipment ${shipment_id} does not carry PO ${po_number}`, 400);

  const receipts = await M.readReceipts();
  const norm = (x) => String(x || '').trim().toUpperCase();
  let r = receipts.find((x) => x.po_number === po_number && norm(x.netsuite_ir_tranid) === norm(ir_tranid));
  if (!r) {
    const ir = await require('../../../services/integrationService').fetchItemReceiptByTranid(ir_tranid).catch(() => null);
    if (!ir) err(`Item Receipt "${ir_tranid}" not found in NetSuite`, 404);
    r = receipts.find((x) => String(x.netsuite_ir_id) === String(ir.ir_id));
    if (!r) {
      const seq = receipts.reduce((mx, x) => Math.max(mx, +String(x.id).replace(/\D/g, '') || 0), 0) + 1;
      r = { id: `mir_${seq}`, netsuite_ir_id: ir.ir_id, netsuite_ir_tranid: ir.ir_tranid, po_number,
        receipt_date: ir.receipt_date, source: 'manual', matched_shipment_id: null, confirmed_by: null, confirmed_at: null };
      receipts.push(r);
    }
  }
  unmatchSiblings(receipts, r, shipment_id);
  r.matched_shipment_id = shipment_id;
  r.confirmed_by = req.user?.id || null;
  r.confirmed_at = new Date().toISOString();
  await M.writeReceipts(receipts);
  const rejections = await M.readRejections().catch(() => []);
  const kept = withoutRejection(rejections, r.id, shipment_id);
  if (kept.length !== rejections.length) await M.writeRejections(kept);
  res.json(r);
}

module.exports = { setMatch, clearMatch, manualMatch, rejectMatch, unrejectMatch };
