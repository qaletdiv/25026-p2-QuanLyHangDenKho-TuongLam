'use strict';

// po_orders (po_number grain) + po_order_lines (per-SKU ordered qty).
// Both NetSuite-owned. Thin read wrappers over the normalized migrated dataset.
const BaseModel = require('../../models/BaseModel');

const orders     = new BaseModel('migrated/po_orders.json');
const orderLines = new BaseModel('migrated/po_order_lines.json');

module.exports = {
  readOrders:     () => orders.read(),
  writeOrders:    (d) => orders.write(d),
  readOrderLines: () => orderLines.read(),
  writeOrderLines:(d) => orderLines.write(d),
};
