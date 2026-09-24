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
  poNumber: Joi.string().min(1).required().messages({ 'any.required': "each pos entry needs a 'poNumber'" }),
  units: Joi.number().integer().min(1).required().messages({
    'number.min': "'units' must be at least 1",
    'any.required': "each pos entry needs 'units'",
  }),
  cartons: Joi.number().integer().min(0).allow(null),
});

// POST /sms/shipments — vendor enters: courier, tracking number, PO(s) + qty & cartons.
const shipmentCreate = Joi.object({
  courierId: Joi.string().min(1).required().messages({ 'any.required': "'courierId' is required" }),
  trackingNumber: Joi.string().trim().allow(null, ''),
  shipDate: isoDate,
  facilityId: Joi.string().allow(null, ''),
  // Optional and normally omitted — a vendor-entered consignment IS a courier
  // parcel, and a null mode falls back to COURIER on the NetSuite push. It exists
  // so a booked/staff-entered box can state Sea or Air.
  modeId: Joi.string().allow(null, ''),
  pos: Joi.array().items(shipmentPoRef).min(1).required().messages({
    'array.min': "'pos' must contain at least one PO",
    'any.required': "'pos' is required",
  }),
  force_overship: Joi.boolean(),
});

// PUT /sms/shipments/:id — header fields + per-PO units/cartons corrections
// (existing junction rows only; adding/removing POs = delete + recreate).
// customsEntryNumber/freight/duty are the BOOKED-consignment financials: actuals
// off the broker bill (mainline behaviour). Only accepted on a booked shipment —
// the controller rejects them on a bookingless one, which has no formal entry.
const shipmentUpdate = Joi.object({
  courierId: Joi.string().min(1),
  // Correctable after the fact — the drafts created before bookings carried a
  // carrier/mode were all stamped FedEx/COURIER, and this is how they are fixed.
  modeId: Joi.string().allow(null, ''),
  trackingNumber: Joi.string().trim().allow(null, ''),
  shipDate: isoDate,
  facilityId: Joi.string().allow(null, ''),
  manual_status: Joi.string().allow(null, ''),   // status NAME (module='sms'); resolved to id
  customsEntryNumber: Joi.string().trim().allow(null, ''),
  freight: Joi.number().min(0).allow(null),
  duty: Joi.number().min(0).allow(null),
  pos: Joi.array().items(shipmentPoRef),
  force_overship: Joi.boolean(),
});

// ── SMS bookings (optional authorization step, added 2026-08-07) ──────────────

// One PO-lot on a booking. lotNumber is server-assigned on create (next free lot
// past anything shipped OR booked); callers may pin it when re-booking a known lot.
const bookingPoRef = Joi.object({
  poNumber: Joi.string().min(1).required().messages({ 'any.required': "each pos entry needs a 'poNumber'" }),
  lotNumber: Joi.number().integer().min(1).allow(null),
  units: Joi.number().integer().min(1).required().messages({
    'number.min': "'units' must be at least 1",
    'any.required': "each pos entry needs 'units'",
  }),
  cartons: Joi.number().integer().min(0).allow(null),
  weightKg: Joi.number().min(0).allow(null),
  cbm: Joi.number().min(0).allow(null),
});

const bookingCreate = Joi.object({
  supplierId: Joi.string().min(1).required().messages({ 'any.required': "'supplierId' is required" }),
  incotermId: Joi.string().allow(null, ''),
  // REQUIRED (2026-08-24). Both were absent and approve silently stamped FedEx +
  // COURIER on the draft, which is what reached NetSuite as the shipping method.
  // A booking is a deliberate plan, so the carrier and mode are stated, not guessed.
  // Independent fields: Ceva runs both sea and air.
  courierId: Joi.string().min(1).required().messages({ 'any.required': "'courierId' is required — pick the carrier" }),
  modeId: Joi.string().min(1).required().messages({ 'any.required': "'modeId' is required — pick Sea, Air or Courier" }),
  cargoReadyDate: isoDate,
  pos: Joi.array().items(bookingPoRef).min(1).required().messages({
    'array.min': "'pos' must contain at least one PO",
    'any.required': "'pos' is required",
  }),
  force_overbook: Joi.boolean(),
});

// PATCH — Pending bookings only (the controller enforces that).
const bookingUpdate = Joi.object({
  incotermId: Joi.string().allow(null, ''),
  courierId: Joi.string().min(1),
  modeId: Joi.string().min(1),
  cargoReadyDate: isoDate,
  pos: Joi.array().items(bookingPoRef).min(1),
  force_overbook: Joi.boolean(),
});

// (receiptCreate / receiptConfirm removed with the receiving page 2026-07-03 —
//  receipts sync from NetSuite; there are no receipt WRITE endpoints for lines.)

// POST /sms/receipts/:id/match — confirm which shipment an Item Receipt received.
// Reactivates sms_item_receipts.matchedShipmentId (2026-07-22) to drive landed
// -cost IR targeting: which of a PO's IRs a given shipment's landed cost posts to.
const receiptMatch = Joi.object({
  shipmentId: Joi.string().min(1).required().messages({ 'any.required': "'shipmentId' is required" }),
});

// POST /sms/receipts/manual-match — type the IR document number when nothing auto-matched.
const receiptManualMatch = Joi.object({
  shipmentId: Joi.string().min(1).required(),
  poNumber: Joi.string().min(1).required(),
  ir_tranid: Joi.string().trim().min(1).required().messages({ 'any.required': "'ir_tranid' (the IR number, e.g. IR65377) is required" }),
});

module.exports = {
  shipmentCreate, shipmentUpdate, receiptMatch, receiptManualMatch,
  bookingCreate, bookingUpdate,
};
