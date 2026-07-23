'use strict';

const Joi = require('joi');

// POST /mainline/bookings/:id/ci — the CI header + SKU line items written to disk.
// qty must be a non-negative number (a negative or garbage qty corrupts the
// fulfillment three-way match); dates must be ISO calendar dates.
const isoDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
  .custom((v, helpers) => (isNaN(new Date(v).getTime()) ? helpers.error('any.invalid') : v))
  .allow(null, '').messages({
    'string.pattern.base': 'Dates must be YYYY-MM-DD',
    'any.invalid': 'Not a valid calendar date',
  });

const lineItem = Joi.object({
  sku_code: Joi.string().min(1).required().messages({ 'any.required': "each line item needs a 'sku_code'" }),
  qty: Joi.number().min(0).required().messages({
    'number.min': "'qty' cannot be negative",
    'any.required': "each line item needs a 'qty'",
  }),
  weight_kg: Joi.number().min(0).allow(null),
  cbm: Joi.number().min(0).allow(null),
  matched_leg_id: Joi.string().allow(null, ''),
  matched_po: Joi.string().allow(null, ''),
}).unknown(true);

const upsert = Joi.object({
  invoice_number: Joi.string().allow(null, ''),
  invoice_date: isoDate,
  source: Joi.string().allow(null, ''),
  file_url: Joi.string().allow(null, ''),
  line_items: Joi.array().items(lineItem),
}).unknown(true);

module.exports = { upsert };
