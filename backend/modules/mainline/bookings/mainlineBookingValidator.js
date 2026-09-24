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

// Booking is keyed on LEGS (legId), not poNumber — enforces the leg-only rule
// at the shape level. supplierId identifies the vendor; the controller verifies
// every leg belongs to that supplier (G1).
const legRef = Joi.object({
  legId:  Joi.string().min(1).required().messages({ 'any.required': "each poLegs entry needs a 'legId'" }),
  units:   Joi.number().min(0).allow(null),
  cartons: Joi.number().min(0).allow(null),
  weightKg: Joi.number().min(0).allow(null),
  cbm:     Joi.number().min(0).allow(null),
}).unknown(true);

// PLANNED carrier — optional (not always decided when the vendor submits) and
// correctable on the shipment afterwards. The controller checks it against
// couriers.json; that is the real guard, since these schemas are unknown(true).
const courierId = Joi.string().allow(null, '');

const create = Joi.object({
  supplierId: Joi.string().min(1).required().messages({ 'any.required': "'supplierId' is required" }),
  courierId: courierId,
  poLegs: Joi.array().items(legRef).min(1).required().messages({
    'array.min': "'poLegs' must contain at least one leg",
    'any.required': "'poLegs' is required",
  }),
  bookingStatus: Joi.string().valid(...MAINLINE_BOOKING_STATUSES).allow('', null),
}).unknown(true);

const update = Joi.object({
  bookingStatus: Joi.string().valid(...MAINLINE_BOOKING_STATUSES).allow('', null).messages({
    'any.only': `'bookingStatus' must be one of: ${MAINLINE_BOOKING_STATUSES.join(', ')}`,
  }),
  cargoReadyDate: isoDate,
  courierId: courierId,
  poLegs: Joi.array().items(legRef).allow(null),
}).unknown(true);

module.exports = { create, update };
