'use strict';

// mainline_commercial_invoices (1:1 with booking). CI line items are NOT stored —
// they are derived from mainline_packing_cartons at read-time (folded 2026-07-07;
// see ci/ciLines.js).
const BaseModel = require('../../../models/BaseModel');

const invoices = new BaseModel('migrated/mainline_commercial_invoices.json');

module.exports = {
  readInvoices:  () => invoices.read(),
  writeInvoices: (d) => invoices.write(d),
};
