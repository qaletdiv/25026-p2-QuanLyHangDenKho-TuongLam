'use strict';

// GET /mainline/fulfillment/:trn — three-way match (ordered/allocated/shipped/received).
const { models } = require('../../../models');
const { deriveAllCiLines } = require('../ci/ciLines');
const { compute, reconcilePo, reconcileLeg } = require('./fulfillmentService');
const { assertTrnVisible, assertPoNumberVisible, assertLegVisible } = require('../vendorAccess');

async function _ctx() {
  const [masters, orders, orderLines, legs, legLines, invoices, cartons, receipts, receiptLines, modes, shipmentLegs] = await Promise.all([
    models.po_masters.read(), models.po_orders.read(), models.po_order_lines.read(),
    models.mainline_po_legs.read(), models.mainline_po_leg_lines.read(),
    models.mainline_commercial_invoices.read(), models.mainline_packing_cartons.read(),
    models.mainline_item_receipts.read().catch(() => []),
    models.mainline_item_receipt_lines.read().catch(() => []),
    models.modes.read().catch(() => []),
    // Only to answer "does a consignment exist for this leg" — that decides what
    // `variance` compares received against. See fulfillmentService.
    models.mainline_shipment_legs.read().catch(() => []),
  ]);
  const ciLines = deriveAllCiLines(cartons);   // derived from packing cartons (not stored)
  return { masters, orders, orderLines, legs, legLines, invoices, ciLines, receipts, receiptLines, modes, shipmentLegs };
}

// GET /mainline/fulfillment/:trn — TRN-grained three-way match.
async function getFulfillment(req, res) {
  const { trn } = req.params;
  await assertTrnVisible(req, trn, `PO master not found: ${trn}`);
  const c = await _ctx();
  if (!c.masters.some((m) => m.trnNumber === trn)) {
    const e = new Error(`PO master not found: ${trn}`); e.statusCode = 404; throw e;
  }
  res.json(compute(trn, c));
}

// GET /mainline/fulfillment/po/:poNumber — one component PO (SMS-style reconcile:
// ordered / shipped / received / remaining / variance per SKU).
async function getPoReconcile(req, res) {
  const { poNumber } = req.params;
  await assertPoNumberVisible(req, poNumber, `PO not found: ${poNumber}`);
  const c = await _ctx();
  if (!c.orders.some((o) => o.poNumber === poNumber)) {
    const e = new Error(`PO not found: ${poNumber}`); e.statusCode = 404; throw e;
  }
  res.json(reconcilePo(poNumber, c));
}

// GET /mainline/fulfillment/leg/:legId — one PO leg (air/sea split): allocated /
// shipped / received scoped to the leg, with receipts split across the PO's legs.
async function getLegReconcile(req, res) {
  const { legId } = req.params;
  await assertLegVisible(req, legId, `PO leg not found: ${legId}`);
  const c = await _ctx();
  const result = reconcileLeg(legId, c);
  if (!result) { const e = new Error(`PO leg not found: ${legId}`); e.statusCode = 404; throw e; }
  res.json(result);
}

module.exports = { getFulfillment, getPoReconcile, getLegReconcile };
