'use strict';

const Joi = require('joi');

const isoDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
  .custom((v, helpers) => (isNaN(new Date(v).getTime()) ? helpers.error('any.invalid') : v))
  .allow(null, '').messages({
    'string.pattern.base': 'Dates must be YYYY-MM-DD',
    'any.invalid': 'Not a valid calendar date',
  });

// One PO in a consignment: the vendor-entered facts (PO totals — no SKU lines).
const shipmentPoRef = Joi.object({
  po_number: Joi.string().min(1).required().messages({ 'any.required': "each pos entry needs a 'po_number'" }),
  units: Joi.number().integer().min(1).required().messages({
    'number.min': "'units' must be at least 1",
    'any.required': "each pos entry needs 'units'",
  }),
  cartons: Joi.number().integer().min(0).allow(null),
});

// POST /sms/shipments — vendor enters: courier, tracking number, PO(s) + qty & cartons.
const shipmentCreate = Joi.object({
  courier_id: Joi.string().min(1).required().messages({ 'any.required': "'courier_id' is required" }),
  tracking_number: Joi.string().trim().allow(null, ''),
  ship_date: isoDate,
  facility_id: Joi.string().allow(null, ''),
  pos: Joi.array().items(shipmentPoRef).min(1).required().messages({
    'array.min': "'pos' must contain at least one PO",
    'any.required': "'pos' is required",
  }),
  force_overship: Joi.boolean(),
});

// PUT /sms/shipments/:id — header fields + per-PO units/cartons corrections
// (existing junction rows only; adding/removing POs = delete + recreate).
const shipmentUpdate = Joi.object({
  courier_id: Joi.string().min(1),
  tracking_number: Joi.string().trim().allow(null, ''),
  ship_date: isoDate,
  facility_id: Joi.string().allow(null, ''),
  manual_status: Joi.string().allow(null, ''),   // status NAME (module='sms'); resolved to id
  pos: Joi.array().items(shipmentPoRef),
  force_overship: Joi.boolean(),
});

// (receiptCreate / receiptConfirm removed with the receiving page 2026-07-03 —
//  receipts sync from NetSuite; there are no receipt WRITE endpoints for lines.)

// POST /sms/receipts/:id/match — confirm which shipment an Item Receipt received.
// Reactivates sms_item_receipts.matched_shipment_id (2026-07-22) to drive landed
// -cost IR targeting: which of a PO's IRs a given shipment's landed cost posts to.
const receiptMatch = Joi.object({
  shipment_id: Joi.string().min(1).required().messages({ 'any.required': "'shipment_id' is required" }),
});

// POST /sms/receipts/manual-match — type the IR document number when nothing auto-matched.
const receiptManualMatch = Joi.object({
  shipment_id: Joi.string().min(1).required(),
  po_number: Joi.string().min(1).required(),
  ir_tranid: Joi.string().trim().min(1).required().messages({ 'any.required': "'ir_tranid' (the IR number, e.g. IR65377) is required" }),
});

module.exports = { shipmentCreate, shipmentUpdate, receiptMatch, receiptManualMatch };
