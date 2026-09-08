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
  // Optional and normally omitted — a vendor-entered consignment IS a courier
  // parcel, and a null mode falls back to COURIER on the NetSuite push. It exists
  // so a booked/staff-entered box can state Sea or Air.
  mode_id: Joi.string().allow(null, ''),
  pos: Joi.array().items(shipmentPoRef).min(1).required().messages({
    'array.min': "'pos' must contain at least one PO",
    'any.required': "'pos' is required",
  }),
  force_overship: Joi.boolean(),
});

// PUT /sms/shipments/:id — header fields + per-PO units/cartons corrections
// (existing junction rows only; adding/removing POs = delete + recreate).
// customs_entry_number/freight/duty are the BOOKED-consignment financials: actuals
// off the broker bill (mainline behaviour). Only accepted on a booked shipment —
// the controller rejects them on a bookingless one, which has no formal entry.
const shipmentUpdate = Joi.object({
  courier_id: Joi.string().min(1),
  // Correctable after the fact — the drafts created before bookings carried a
  // carrier/mode were all stamped FedEx/COURIER, and this is how they are fixed.
  mode_id: Joi.string().allow(null, ''),
  tracking_number: Joi.string().trim().allow(null, ''),
  ship_date: isoDate,
  facility_id: Joi.string().allow(null, ''),
  manual_status: Joi.string().allow(null, ''),   // status NAME (module='sms'); resolved to id
  customs_entry_number: Joi.string().trim().allow(null, ''),
  freight: Joi.number().min(0).allow(null),
  duty: Joi.number().min(0).allow(null),
  pos: Joi.array().items(shipmentPoRef),
  force_overship: Joi.boolean(),
});

// ── SMS bookings (optional authorization step, added 2026-08-07) ──────────────

// One PO-lot on a booking. lot_number is server-assigned on create (next free lot
// past anything shipped OR booked); callers may pin it when re-booking a known lot.
const bookingPoRef = Joi.object({
  po_number: Joi.string().min(1).required().messages({ 'any.required': "each pos entry needs a 'po_number'" }),
  lot_number: Joi.number().integer().min(1).allow(null),
  units: Joi.number().integer().min(1).required().messages({
    'number.min': "'units' must be at least 1",
    'any.required': "each pos entry needs 'units'",
  }),
  cartons: Joi.number().integer().min(0).allow(null),
  weight_kg: Joi.number().min(0).allow(null),
  cbm: Joi.number().min(0).allow(null),
});

const bookingCreate = Joi.object({
  supplier_id: Joi.string().min(1).required().messages({ 'any.required': "'supplier_id' is required" }),
  incoterm_id: Joi.string().allow(null, ''),
  // REQUIRED (2026-08-24). Both were absent and approve silently stamped FedEx +
  // COURIER on the draft, which is what reached NetSuite as the shipping method.
  // A booking is a deliberate plan, so the carrier and mode are stated, not guessed.
  // Independent fields: Ceva runs both sea and air.
  courier_id: Joi.string().min(1).required().messages({ 'any.required': "'courier_id' is required — pick the carrier" }),
  mode_id: Joi.string().min(1).required().messages({ 'any.required': "'mode_id' is required — pick Sea, Air or Courier" }),
  cargo_ready_date: isoDate,
  pos: Joi.array().items(bookingPoRef).min(1).required().messages({
    'array.min': "'pos' must contain at least one PO",
    'any.required': "'pos' is required",
  }),
  force_overbook: Joi.boolean(),
});

// PATCH — Pending bookings only (the controller enforces that).
const bookingUpdate = Joi.object({
  incoterm_id: Joi.string().allow(null, ''),
  courier_id: Joi.string().min(1),
  mode_id: Joi.string().min(1),
  cargo_ready_date: isoDate,
  pos: Joi.array().items(bookingPoRef).min(1),
  force_overbook: Joi.boolean(),
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

module.exports = {
  shipmentCreate, shipmentUpdate, receiptMatch, receiptManualMatch,
  bookingCreate, bookingUpdate,
};
