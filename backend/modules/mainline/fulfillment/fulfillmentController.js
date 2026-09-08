'use strict';

// GET /mainline/fulfillment/:trn — three-way match (ordered/allocated/shipped/received).
const PoMasterModel = require('../../po/PoMasterModel');
const PoOrderModel = require('../../po/PoOrderModel');
const MainlineLegModel = require('../legs/MainlineLegModel');
const MainlineCiModel = require('../ci/MainlineCiModel');
const MainlinePackingModel = require('../packing/MainlinePackingModel');
const ItemReceiptModel = require('../receipts/MainlineItemReceiptModel');
const BaseModel = require('../../../models/BaseModel');
const { deriveAllCiLines } = require('../ci/ciLines');
const { compute, reconcilePo, reconcileLeg } = require('./fulfillmentService');
const { assertTrnVisible, assertPoNumberVisible, assertLegVisible } = require('../vendorAccess');

async function _ctx() {
  const [masters, orders, orderLines, legs, legLines, invoices, cartons, receipts, receiptLines, modes] = await Promise.all([
    PoMasterModel.read(), PoOrderModel.readOrders(), PoOrderModel.readOrderLines(),
    MainlineLegModel.readLegs(), MainlineLegModel.readLegLines(),
    MainlineCiModel.readInvoices(), MainlinePackingModel.read(),
    ItemReceiptModel.readReceipts().catch(() => []), ItemReceiptModel.readReceiptLines().catch(() => []),
    new BaseModel('modes.json').read().catch(() => []),
  ]);
  const ciLines = deriveAllCiLines(cartons);   // derived from packing cartons (not stored)
  return { masters, orders, orderLines, legs, legLines, invoices, ciLines, receipts, receiptLines, modes };
}

// GET /mainline/fulfillment/:trn — TRN-grained three-way match.
async function getFulfillment(req, res) {
  const { trn } = req.params;
  await assertTrnVisible(req, trn, `PO master not found: ${trn}`);
  const c = await _ctx();
  if (!c.masters.some((m) => m.trn_number === trn)) {
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
  if (!c.orders.some((o) => o.po_number === poNumber)) {
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
