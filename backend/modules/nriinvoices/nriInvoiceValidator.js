'use strict';

// Joi schemas for this module's JSON writes (the upload routes carry multipart,
// which validate.js does not inspect — their fields are checked in the controller).

const Joi = require('joi');

// POST /nri-invoices/sources — register another invoicing warehouse.
// `parser` / `upload_enabled` are deliberately NOT accepted: a warehouse always
// starts as a shell with uploads off, and enabling one means mapping its file
// layout in code, not posting a flag.
const source = Joi.object({
    label:       Joi.string().trim().min(1).max(60).required(),
    // URL code; derived from the label when omitted
    code:        Joi.string().trim().max(40).optional(),
    // the key the coding legend, rate card and invoice ids turn on
    entity:      Joi.string().trim().max(20).optional(),
    facility_id: Joi.string().trim().max(60).allow('', null).optional(),
});

module.exports = { source };
