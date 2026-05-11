const Joi = require('joi');

// Each po_details slot in the booking form
const poDetailSchema = Joi.object({
    po_number: Joi.string().allow('', null),
    units:   Joi.alternatives().try(Joi.number().min(0), Joi.string().allow('')).allow(null),
    cartons: Joi.alternatives().try(Joi.number().min(0), Joi.string().allow('')).allow(null),
    weight:  Joi.alternatives().try(Joi.number().min(0), Joi.string().allow('')).allow(null),
    cbm:     Joi.alternatives().try(Joi.number().min(0), Joi.string().allow('')).allow(null),
}).unknown(true);

const BOOKING_STATUSES = [
    'Booking Pending', 'Booking Approved', 'Declined',
    'Customs Clearance', 'In-Transit', 'Delivered',
    'Cancelled', 'Rejected', 'No Booking',
];

const create = Joi.object({
    vendor_name: Joi.string().min(1).required().messages({
        'string.empty': "'vendor_name' is required",
        'any.required': "'vendor_name' is required",
    }),
    po_details: Joi.array().items(poDetailSchema).min(1).required().messages({
        'array.min': "'po_details' must contain at least one entry",
        'any.required': "'po_details' is required",
    }),
    type: Joi.string().valid('mainline', 'sms').default('mainline'),
    booking_status: Joi.string().valid(...BOOKING_STATUSES).allow('', null),
    // All other fields are optional — they flow through via allowUnknown
}).unknown(true);

const update = Joi.object({
    booking_status: Joi.string().valid(...BOOKING_STATUSES).allow('', null).messages({
        'any.only': `'booking_status' must be one of: ${BOOKING_STATUSES.join(', ')}`,
    }),
    type: Joi.string().valid('mainline', 'sms').allow('', null),
    po_details: Joi.array().items(poDetailSchema).allow(null),
}).unknown(true);

module.exports = { create, update };
