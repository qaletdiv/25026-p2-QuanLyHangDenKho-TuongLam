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
  res.json(r);
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
  res.json(r);
}

module.exports = { setMatch, clearMatch, manualMatch };
