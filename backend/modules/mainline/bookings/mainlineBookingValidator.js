'use strict';

const Joi = require('joi');
const { MAINLINE_BOOKING_STATUSES } = require('../statuses');

// ISO calendar date (YYYY-MM-DD); the custom check rejects impossible dates.
const isoDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
  .custom((v, helpers) => (isNaN(new Date(v).getTime()) ? helpers.error('any.invalid') : v))
  .allow(null, '').messages({
    'string.pattern.base': 'Cargo Ready must be YYYY-MM-DD',
    'any.invalid': 'Not a valid calendar date',
  });

// Booking is keyed on LEGS (leg_id), not po_number — enforces the leg-only rule
// at the shape level. supplier_id identifies the vendor; the controller verifies
// every leg belongs to that supplier (G1).
const legRef = Joi.object({
  leg_id:  Joi.string().min(1).required().messages({ 'any.required': "each po_legs entry needs a 'leg_id'" }),
  units:   Joi.number().min(0).allow(null),
  cartons: Joi.number().min(0).allow(null),
  weight_kg: Joi.number().min(0).allow(null),
  cbm:     Joi.number().min(0).allow(null),
}).unknown(true);

// PLANNED carrier — optional (not always decided when the vendor submits) and
// correctable on the shipment afterwards. The controller checks it against
// couriers.json; that is the real guard, since these schemas are unknown(true).
const courierId = Joi.string().allow(null, '');

const create = Joi.object({
  supplier_id: Joi.string().min(1).required().messages({ 'any.required': "'supplier_id' is required" }),
  courier_id: courierId,
  po_legs: Joi.array().items(legRef).min(1).required().messages({
    'array.min': "'po_legs' must contain at least one leg",
    'any.required': "'po_legs' is required",
  }),
  booking_status: Joi.string().valid(...MAINLINE_BOOKING_STATUSES).allow('', null),
}).unknown(true);

const update = Joi.object({
  booking_status: Joi.string().valid(...MAINLINE_BOOKING_STATUSES).allow('', null).messages({
    'any.only': `'booking_status' must be one of: ${MAINLINE_BOOKING_STATUSES.join(', ')}`,
  }),
  cargo_ready_date: isoDate,
  courier_id: courierId,
  po_legs: Joi.array().items(legRef).allow(null),
}).unknown(true);

module.exports = { create, update };
