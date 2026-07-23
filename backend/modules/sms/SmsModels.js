'use strict';

// SMS dataset models — the module's OWN tables (see database.dbml SMS section).
// No mainline_* file is ever read or written by this module; shared reads are
// reference/master data only (suppliers, seasons, facilities, statuses, couriers,
// product_skus).

const BaseModel = require('../../models/BaseModel');

module.exports = {
  pos:            new BaseModel('migrated/sms_pos.json'),
  poLines:        new BaseModel('migrated/sms_po_lines.json'),
  shipments:      new BaseModel('migrated/sms_shipments.json'),
  shipmentPos:    new BaseModel('migrated/sms_shipment_pos.json'),
  trackingEvents: new BaseModel('migrated/sms_tracking_events.json'),
  receipts:       new BaseModel('migrated/sms_item_receipts.json'),
  receiptLines:   new BaseModel('migrated/sms_item_receipt_lines.json'),
  packingCartons: new BaseModel('migrated/sms_packing_cartons.json'),   // shipping data (carton × SKU)
  documents:      new BaseModel('migrated/sms_documents.json'),         // generated CI + packing-list files
  courierStatusMap: new BaseModel('migrated/courier_status_map.json'),
  // shared reference/master data (read-only here)
  statuses:       new BaseModel('migrated/statuses.json'),
  seasons:        new BaseModel('migrated/seasons.json'),
  facilities:     new BaseModel('migrated/warehouse_facilities.json'),
  allocationChannels: new BaseModel('migrated/allocation_channels.json'),   // Reserved / First
  skus:           new BaseModel('migrated/product_skus.json'),
  suppliers:      new BaseModel('suppliers.json'),
  couriers:       new BaseModel('couriers.json'),
  users:          new BaseModel('users.json'),
};
