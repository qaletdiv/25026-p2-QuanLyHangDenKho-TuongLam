'use strict';

// po_master_totals view — the season-start "how much we'll order" ORDER INTENT.
// Per-SKU ordered qty summed across all warehouse orders under a TRN. Distinct
// from the /forecast page (shipment-arrival-by-week). Derived live, never stored.

const { models } = require('../../models');
const { assertTrnVisible } = require('../mainline/vendorAccess');

const notFound = (msg) => { const e = new Error(msg); e.statusCode = 404; throw e; };

// GET /po/:trn/order-intent
async function getOrderIntent(req, res) {
  const { trn } = req.params;
  await assertTrnVisible(req, trn, `PO master not found: ${trn}`);
  const [masters, orders, orderLines] = await Promise.all([
    models.po_masters.read(),
    models.po_orders.read(),
    models.po_order_lines.read(),
  ]);

  const master = masters.find((m) => m.trnNumber === trn);
  if (!master) notFound(`PO master not found: ${trn}`);

  const poNumbers = new Set(orders.filter((o) => o.trnNumber === trn).map((o) => o.poNumber));

  // sum orderedQty per sku across this TRN's orders
  const bySku = new Map();
  orderLines.forEach((l) => {
    if (!poNumbers.has(l.poNumber)) return;
    bySku.set(l.skuCode, (bySku.get(l.skuCode) || 0) + (l.orderedQty || 0));
  });

  const totals = [...bySku.entries()]
    .map(([skuCode, orderedQty]) => ({ skuCode, orderedQty }))
    .sort((a, b) => a.skuCode.localeCompare(b.skuCode));

  res.json({
    trnNumber: trn,
    skuCount:  totals.length,
    total_qty:  totals.reduce((s, t) => s + t.orderedQty, 0),
    totals,
  });
}

module.exports = { getOrderIntent };
