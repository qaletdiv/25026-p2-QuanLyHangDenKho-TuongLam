'use strict';

const Joi = require('joi');
const { MAINLINE_SHIPMENT_STATUSES } = require('../statuses');

// ISO calendar date — a malformed date would corrupt transit-time calculations.
// The pattern catches the shape; the custom check catches impossible dates like
// 2026-13-45 (ISO parsing returns Invalid Date for out-of-range components).
// Ordering across the fields is the controller's checkChronology guard.
const isoDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
  .custom((v, helpers) => (isNaN(new Date(v).getTime()) ? helpers.error('any.invalid') : v))
  .allow(null, '').messages({
    'string.pattern.base': 'Dates must be YYYY-MM-DD',
    'any.invalid': 'Not a valid calendar date',
  });

// Mainline shipment update — status vocabulary + header-field types. The
// controller whitelists which fields are written; this validates their shape.
const update = Joi.object({
  status: Joi.string().valid(...MAINLINE_SHIPMENT_STATUSES).messages({
    'any.only': `'status' must be one of: ${MAINLINE_SHIPMENT_STATUSES.join(', ')}`,
  }),
  etd_pol: isoDate, eta_pod: isoDate, e_del: isoDate, cargo_received_date: isoDate, ata: isoDate,
  bl_no: Joi.string().allow(null, ''),
  container_type_id: Joi.string().allow(null, ''),
  pol_port_id: Joi.string().allow(null, ''),
  pod_port_id: Joi.string().allow(null, ''),
  netsuite_id: Joi.string().allow(null, ''),
  invoice_value: Joi.number().min(0).allow(null),
  duty: Joi.number().min(0).allow(null),
  freight: Joi.number().min(0).allow(null),
}).unknown(true);

const bulkStatus = Joi.object({
  ids:    Joi.array().items(Joi.string()).min(1).required(),
  status: Joi.string().valid(...MAINLINE_SHIPMENT_STATUSES).required(),
}).unknown(true);

module.exports = { update, bulkStatus };
