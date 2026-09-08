'use strict';

// po_master_totals view — the season-start "how much we'll order" ORDER INTENT.
// Per-SKU ordered qty summed across all warehouse orders under a TRN. Distinct
// from the /forecast page (shipment-arrival-by-week). Derived live, never stored.

const PoMasterModel = require('./PoMasterModel');
const PoOrderModel  = require('./PoOrderModel');
const { assertTrnVisible } = require('../mainline/vendorAccess');

const notFound = (msg) => { const e = new Error(msg); e.statusCode = 404; throw e; };

// GET /po/:trn/order-intent
async function getOrderIntent(req, res) {
  const { trn } = req.params;
  await assertTrnVisible(req, trn, `PO master not found: ${trn}`);
  const [masters, orders, orderLines] = await Promise.all([
    PoMasterModel.read(),
    PoOrderModel.readOrders(),
    PoOrderModel.readOrderLines(),
  ]);

  const master = masters.find((m) => m.trn_number === trn);
  if (!master) notFound(`PO master not found: ${trn}`);

  const poNumbers = new Set(orders.filter((o) => o.trn_number === trn).map((o) => o.po_number));

  // sum ordered_qty per sku across this TRN's orders
  const bySku = new Map();
  orderLines.forEach((l) => {
    if (!poNumbers.has(l.po_number)) return;
    bySku.set(l.sku_code, (bySku.get(l.sku_code) || 0) + (l.ordered_qty || 0));
  });

  const totals = [...bySku.entries()]
    .map(([sku_code, ordered_qty]) => ({ sku_code, ordered_qty }))
    .sort((a, b) => a.sku_code.localeCompare(b.sku_code));

  res.json({
    trn_number: trn,
    sku_count:  totals.length,
    total_qty:  totals.reduce((s, t) => s + t.ordered_qty, 0),
    totals,
  });
}

module.exports = { getOrderIntent };
