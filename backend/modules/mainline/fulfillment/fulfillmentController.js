'use strict';

// GET /mainline/fulfillment/:trn — three-way match (ordered/allocated/shipped/received).
const PoMasterModel = require('../../po/PoMasterModel');
const PoOrderModel = require('../../po/PoOrderModel');
const MainlineLegModel = require('../legs/MainlineLegModel');
const MainlineCiModel = require('../ci/MainlineCiModel');
const MainlinePackingModel = require('../packing/MainlinePackingModel');
const { deriveAllCiLines } = require('../ci/ciLines');
const { compute } = require('./fulfillmentService');

async function getFulfillment(req, res) {
  const { trn } = req.params;
  const [masters, orders, orderLines, legs, legLines, invoices, cartons] = await Promise.all([
    PoMasterModel.read(), PoOrderModel.readOrders(), PoOrderModel.readOrderLines(),
    MainlineLegModel.readLegs(), MainlineLegModel.readLegLines(),
    MainlineCiModel.readInvoices(), MainlinePackingModel.read(),
  ]);
  const ciLines = deriveAllCiLines(cartons);   // derived from packing cartons (not stored)
  if (!masters.some((m) => m.trn_number === trn)) {
    const e = new Error(`PO master not found: ${trn}`); e.statusCode = 404; throw e;
  }
  res.json(compute(trn, { orders, orderLines, legs, legLines, invoices, ciLines }));
}

module.exports = { getFulfillment };
