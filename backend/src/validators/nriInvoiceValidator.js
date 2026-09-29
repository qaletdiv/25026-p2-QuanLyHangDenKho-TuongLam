'use strict';

// Schemas for this module's JSON writes (the upload routes carry multipart,
// which validate.js does not inspect — their fields are checked in the controller).

const { requiredString, optionalString, nullableString } = require('./rules');

// POST /nri-invoices/sources — register another invoicing warehouse.
// `parser` / `uploadEnabled` are deliberately NOT accepted: a warehouse always
// starts as a shell with uploads off, and enabling one means mapping its file
// layout in code, not posting a flag.
const source = {
    label: requiredString("'label' is required", { max: 60 }),
    // URL code; derived from the label when omitted. null and '' are refused —
    // send the key or leave it out entirely.
    code: optionalString("'code' must not be empty", { max: 40 }),
    // the key the coding legend, rate card and invoice ids turn on
    entity: optionalString("'entity' must not be empty", { max: 20 }),
    facilityId: nullableString({ trim: true, max: 60 }),   // nullable + clearable
};

module.exports = { source };
