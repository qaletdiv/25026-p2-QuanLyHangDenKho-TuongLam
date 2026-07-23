'use strict';

// SMS Item Receipt matching — confirm which SHIPMENT (lot) an Item Receipt
// received. This is the human sign-off on the auto-suggested match (receiptMatch
// .matchPo, quantity → sequence) and is what lets the landed-cost push target the
// correct IR when a PO has several receipts. Writes ONLY the portal-owned
// confirmation columns on sms_item_receipts (matched_shipment_id / confirmed_*);
// NetSuite-owned IR facts are never touched (the sync preserves these on re-sync).

const M = require('./SmsModels');
const { resolveForShipment } = require('./receiptMatch');

const err = (msg, code) => { const e = new Error(msg); e.statusCode = code; throw e; };

// GET /sms/shipments/:id/receipt-matches — the suggested (or confirmed) IR per PO
// for a shipment. Read-only; drives a confirm UI and lets you inspect a match.
async function suggestForShipment(req, res) {
  const [shipments, shipmentPos, cartons, receipts, receiptLines] = await Promise.all([
    M.shipments.read(), M.shipmentPos.read(), M.packingCartons.read().catch(() => []),
    M.receipts.read().catch(() => []), M.receiptLines.read().catch(() => []),
  ]);
  const s = shipments.find((x) => x.id === req.params.id);
  if (!s) err('SMS shipment not found', 404);
  const poNumbers = [...new Set(shipmentPos.filter((j) => j.shipment_id === s.id).map((j) => j.po_number))];
  const resolved = resolveForShipment(s.id, poNumbers, { junctions: shipmentPos, cartons, receipts, receiptLines, shipments });
  res.json({ shipment_id: s.id, matches: resolved });
}

// POST /sms/receipts/:id/match { shipment_id } — confirm the match.
async function setMatch(req, res) {
  const { shipment_id } = req.body;
  const [receipts, shipmentPos] = await Promise.all([M.receipts.read(), M.shipmentPos.read()]);
  const r = receipts.find((x) => x.id === req.params.id);
  if (!r) err('Item receipt not found', 404);
  // the shipment must actually carry this receipt's PO
  if (!shipmentPos.some((j) => j.shipment_id === shipment_id && j.po_number === r.po_number)) {
    err(`Shipment ${shipment_id} does not carry PO ${r.po_number}`, 400);
  }
  r.matched_shipment_id = shipment_id;
  r.confirmed_by = req.user?.id || null;
  r.confirmed_at = new Date().toISOString();
  await M.receipts.write(receipts);
  res.json(r);
}

// POST /sms/receipts/manual-match { shipment_id, po_number, ir_tranid } — when the
// auto-matcher found no Item Receipt, let the user type the IR document number
// (e.g. IR65377). Resolves it to an existing synced receipt for that PO, else looks
// it up in NetSuite (tranid → internal id) and creates a MANUAL matched receipt row
// so the landed-cost push has a target. The internal id is what the push PATCHes.
async function manualMatch(req, res) {
  const { shipment_id, po_number, ir_tranid } = req.body;
  const [receipts, shipmentPos] = await Promise.all([M.receipts.read(), M.shipmentPos.read()]);
  if (!shipmentPos.some((j) => j.shipment_id === shipment_id && j.po_number === po_number)) {
    err(`Shipment ${shipment_id} does not carry PO ${po_number}`, 400);
  }
  const norm = (x) => String(x || '').trim().toUpperCase();

  // 1) already synced for this PO under that document number?
  let r = receipts.find((x) => x.po_number === po_number && norm(x.netsuite_ir_tranid) === norm(ir_tranid));
  if (!r) {
    // 2) resolve the internal id from NetSuite
    const ir = await require('../../services/integrationService').fetchItemReceiptByTranid(ir_tranid).catch(() => null);
    if (!ir) err(`Item Receipt "${ir_tranid}" not found in NetSuite`, 404);
    // reuse a row if that internal id is already stored (any PO), else create a manual one
    r = receipts.find((x) => String(x.netsuite_ir_id) === String(ir.ir_id));
    if (!r) {
      const seq = receipts.reduce((mx, x) => Math.max(mx, +String(x.id).replace(/\D/g, '') || 0), 0) + 1;
      r = { id: `sir_${seq}`, netsuite_ir_id: ir.ir_id, netsuite_ir_tranid: ir.ir_tranid, po_number,
        receipt_date: ir.receipt_date, source: 'manual', matched_shipment_id: null, confirmed_by: null, confirmed_at: null };
      receipts.push(r);
    }
  }
  r.matched_shipment_id = shipment_id;
  r.confirmed_by = req.user?.id || null;
  r.confirmed_at = new Date().toISOString();
  await M.receipts.write(receipts);
  res.json(r);
}

// DELETE /sms/receipts/:id/match — clear a confirmed match.
async function clearMatch(req, res) {
  const receipts = await M.receipts.read();
  const r = receipts.find((x) => x.id === req.params.id);
  if (!r) err('Item receipt not found', 404);
  r.matched_shipment_id = null;
  r.confirmed_by = null;
  r.confirmed_at = null;
  await M.receipts.write(receipts);
  res.json(r);
}

module.exports = { suggestForShipment, setMatch, clearMatch, manualMatch };
