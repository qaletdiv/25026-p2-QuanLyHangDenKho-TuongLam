'use strict';

// Landed Costs module — its OWN tables (landed_cost_rates + landed_costs) plus
// READ-ONLY access to the SMS dataset it derives from. This module is fully
// ADDITIVE: it never writes to sms_* / mainline_* tables. Freight & duty are
// stored ONLY in landed_costs (keyed by module + shipment_id) — nothing on the
// shipment rows themselves (3NF; the existing modules are untouched).

const BaseModel = require('../../models/BaseModel');

module.exports = {
  // owned tables (read-write)
  rates:          new BaseModel('migrated/landed_cost_rates.json'),   // { id, module, freight_pct, duty_pct }
  landedCosts:    new BaseModel('migrated/landed_costs.json'),        // posted facts (see controller)

  // SMS dataset — READ ONLY here (the basis for the CI value)
  smsShipments:   new BaseModel('migrated/sms_shipments.json'),
  smsShipmentPos: new BaseModel('migrated/sms_shipment_pos.json'),
  smsPos:         new BaseModel('migrated/sms_pos.json'),
  packingCartons: new BaseModel('migrated/sms_packing_cartons.json'),
  smsReceipts:    new BaseModel('migrated/sms_item_receipts.json'),        // for IR-target resolution (push)
  smsReceiptLines: new BaseModel('migrated/sms_item_receipt_lines.json'),

  // MAINLINE dataset — READ ONLY here (freight/duty entered on the shipment; the
  // per-PO split + IR match are derived; posting writes only landed_costs).
  mlShipments:    new BaseModel('migrated/mainline_shipments.json'),        // holds freight/duty/invoice_value
  mlShipmentLegs: new BaseModel('migrated/mainline_shipment_legs.json'),
  mlPoLegs:       new BaseModel('migrated/mainline_po_legs.json'),
  poOrders:       new BaseModel('migrated/po_orders.json'),
  mlPackingCartons: new BaseModel('migrated/mainline_packing_cartons.json'),
  mlReceipts:     new BaseModel('migrated/mainline_item_receipts.json'),
  mlReceiptLines: new BaseModel('migrated/mainline_item_receipt_lines.json'),
  modes:          new BaseModel('modes.json'),

  // shared reference/master data (read only)
  suppliers:      new BaseModel('suppliers.json'),
  couriers:       new BaseModel('couriers.json'),
  facilities:     new BaseModel('migrated/warehouse_facilities.json'),
  seasons:        new BaseModel('migrated/seasons.json'),
};
