'use strict';

// SMS dataset models — the module's OWN tables (see database.dbml SMS section).
// No mainline_* file is ever read or written by this module; shared reads are
// reference/master data only (suppliers, seasons, facilities, statuses, couriers,
// product_skus).

const { models } = require('../../models');

module.exports = {
  pos:            models.sms_pos,
  poLines:        models.sms_po_lines,
  bookings:       models.sms_bookings,        // OPTIONAL booking step
  bookingPos:     models.sms_booking_pos,     // junction: booked PO-lots
  shipments:      models.sms_shipments,
  shipmentPos:    models.sms_shipment_pos,
  trackingEvents: models.sms_tracking_events,
  receipts:       models.sms_item_receipts,
  receiptLines:   models.sms_item_receipt_lines,
  // Human REJECTIONS of an auto-suggested (receipt × shipment) pair — the negative
  // of matchedShipmentId. Own table, not a column: one IR can be rejected against
  // several of its PO's lots, so on the receipt row it would be a repeating group.
  receiptRejections: models.sms_receipt_match_rejections,
  // READ-ONLY here, and owned by the landed-cost module. A posted row records
  // freight & duty already PATCHed onto a live NetSuite Item Receipt, so the
  // shipment lifecycle only asks whether one exists before letting a consignment
  // be cancelled or deleted out from under it.
  landedCosts:    models.landed_costs,
  packingCartons: models.sms_packing_cartons,   // shipping data, (carton × SKU) grain
  cartons:        models.sms_cartons,           // PHYSICAL carton: weights + measure, once per (shipment, ctn)
  documents:      models.sms_documents,         // generated CI + packing-list files
  courierStatusMap: models.courier_status_map,
  // shared reference/master data (read-only here)
  statuses:       models.statuses,
  incoterms:      models.incoterms,
  seasons:        models.seasons,
  facilities:     models.warehouse_facilities,
  allocationChannels: models.allocation_channels,   // Reserved / First
  skus:           models.product_skus,
  suppliers:      models.suppliers,
  couriers:       models.couriers,
  modes:          models.modes,                          // Sea / Air / Courier — booking + shipment mode
  notifyParty:    models.notify_party,          // singleton — the CI's Notify Party block
  users:          models.users,
};
