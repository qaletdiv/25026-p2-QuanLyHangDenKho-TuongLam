const Joi = require('joi');

const MAINLINE_STATUSES = [
    'No Booking', 'Booking', 'Booking Approved', 'Booking Received',
    'Docs Sent', 'Customs Clearance', 'In-Transit', 'In Transit',
    'ASN Sent', 'Delivered', 'Cancelled',
];
const SMS_STATUSES = ['Ready to Ship', 'Pending', 'In-Transit', 'Customs Issue', 'Delivered', 'Cancelled'];
const ALL_STATUSES = [...new Set([...MAINLINE_STATUSES, ...SMS_STATUSES])];

const create = Joi.object({
    po_number: Joi.string().min(1).required().messages({
        'string.empty': "'po_number' is required",
        'any.required': "'po_number' is required",
    }),
    mode: Joi.string().allow('', null),
    status: Joi.string().valid(...ALL_STATUSES).allow('', null).messages({
        'any.only': `'status' must be a valid shipment status`,
    }),
    destination_warehouse: Joi.string().allow('', null),
    expected_quantity: Joi.alternatives().try(Joi.number().min(0), Joi.string().allow('')).allow(null),
    type: Joi.string().valid('mainline', 'sms').allow('', null),
}).unknown(true);

const update = Joi.object({
    status: Joi.string().valid(...ALL_STATUSES).allow('', null).messages({
        'any.only': `'status' must be a valid shipment status`,
    }),
    mode: Joi.string().allow('', null),
    destination_warehouse: Joi.string().allow('', null),
}).unknown(true);

const bulkStatus = Joi.object({
    booking_number: Joi.string().min(1).required().messages({
        'string.empty': "'booking_number' is required",
        'any.required': "'booking_number' is required",
    }),
    status: Joi.string().valid(...ALL_STATUSES).required().messages({
        'any.only': `'status' must be a valid shipment status`,
        'any.required': "'status' is required",
    }),
});

module.exports = { create, update, bulkStatus };
