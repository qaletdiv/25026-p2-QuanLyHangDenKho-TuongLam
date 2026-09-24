'use strict';

// Landed Costs module — its OWN tables (landed_cost_rates + landed_costs) plus
// READ-ONLY access to the SMS dataset it derives from. This module is fully
// ADDITIVE: it never writes to sms_* / mainline_* tables. Freight & duty are
// stored ONLY in landed_costs (keyed by module + shipmentId) — nothing on the
// shipment rows themselves (3NF; the existing modules are untouched).

const { models } = require('../../models');

module.exports = {
  // owned tables (read-write)
  rates:          models.landed_cost_rates,   // { id, module, freightPct, dutyPct }
  landedCosts:    models.landed_costs,        // posted facts (see controller)
  // Commission is a per-supplier % of the CI value (e.g. Pratibha 1.5%). SMS and
  // mainline keep SEPARATE tables — no sharing (per Lam, 2026-07-30). { id, supplierId, commissionPct }
  smsCommissions: models.landed_cost_commissions_sms,
  mlCommissions:  models.landed_cost_commissions_mainline,

  // SMS dataset — READ ONLY here (the basis for the CI value)
  smsShipments:   models.sms_shipments,
  smsShipmentPos: models.sms_shipment_pos,
  smsPos:         models.sms_pos,
  packingCartons: models.sms_packing_cartons,
  smsReceipts:    models.sms_item_receipts,        // for IR-target resolution (push)
  smsReceiptLines: models.sms_item_receipt_lines,
  smsRejections:  models.sms_receipt_match_rejections,   // suggestions a human said no to

  // MAINLINE dataset — READ ONLY here (freight/duty entered on the shipment; the
  // per-PO split + IR match are derived; posting writes only landed_costs).
  mlShipments:    models.mainline_shipments,        // holds freight/duty/invoiceValue
  mlShipmentLegs: models.mainline_shipment_legs,
  mlPoLegs:       models.mainline_po_legs,
  poOrders:       models.po_orders,
  poMasters:      models.po_masters,   // PO → supplier (mainline commission)
  mlPackingCartons: models.mainline_packing_cartons,
  mlReceipts:     models.mainline_item_receipts,
  mlReceiptLines: models.mainline_item_receipt_lines,
  mlRejections:   models.mainline_receipt_match_rejections,   // suggestions a human said no to
  modes:          models.modes,

  // shared reference/master data (read only)
  suppliers:      models.suppliers,
  couriers:       models.couriers,
  facilities:     models.warehouse_facilities,
  seasons:        models.seasons,
};
