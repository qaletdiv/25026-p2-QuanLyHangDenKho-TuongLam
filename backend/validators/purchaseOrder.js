const Joi = require('joi');

const lineItemSchema = Joi.object({
    sku_code:     Joi.string().min(1).required().messages({ 'any.required': "'sku_code' is required on each line item" }),
    description:  Joi.string().allow('', null),
    expected_qty: Joi.alternatives().try(Joi.number().min(0), Joi.string().allow('')).allow(null),
    shipped_qty:  Joi.alternatives().try(Joi.number().min(0), Joi.string().allow('')).allow(null),
}).unknown(true);

const create = Joi.object({
    po_number: Joi.string().min(1).required().messages({
        'string.empty': "'po_number' is required",
        'any.required': "'po_number' is required",
    }),
    expected_qty: Joi.alternatives().try(Joi.number().min(0), Joi.string().allow('')).allow(null),
    supplier:     Joi.string().allow('', null),
    season:       Joi.string().allow('', null),
}).unknown(true);

const update = Joi.object({
    expected_qty: Joi.alternatives().try(Joi.number().min(0), Joi.string().allow('')).allow(null),
    booking_status: Joi.string().allow('', null),
}).unknown(true);

const replaceLineItems = Joi.object({
    line_items: Joi.array().items(lineItemSchema).required().messages({
        'any.required': "'line_items' is required",
        'array.base': "'line_items' must be an array",
    }),
});

const updateLineItem = Joi.object({
    expected_qty: Joi.alternatives().try(Joi.number().min(0), Joi.string().allow('')).allow(null),
    shipped_qty:  Joi.alternatives().try(Joi.number().min(0), Joi.string().allow('')).allow(null),
    description:  Joi.string().allow('', null),
}).unknown(true);

module.exports = { create, update, replaceLineItems, updateLineItem };
