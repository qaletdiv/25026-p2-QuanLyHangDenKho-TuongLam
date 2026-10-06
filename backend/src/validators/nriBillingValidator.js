'use strict';

// Schemas for /nri-billing JSON writes. The two uploads are multipart, which
// validate.js does not inspect — their fields are checked in the controller.

const {
    nullableString, nullableNumber, enumOf, optionalBoolean, optionalArray, optionalString, requiredArray, isoDate, requiredString,
} = require('./rules');

// PATCH /nri-billing/files/:id — mark a file booked in NetSuite, or reopen it.
const updateFile = {
    locked: optionalBoolean,
};

// PUT /nri-billing/lines/override — the workbook's two manual columns, applied
// to `lineIds` or to every line matching `filter`. null CLEARS an override; an
// absent key leaves it untouched (so the two are independent).
const override = {
    entity: enumOf(['CA', 'US'], "entity must be 'CA' or 'US'"),
    files: optionalString("'files' must not be empty", { max: 4000 }),
    month: optionalString("'month' must be YYYY-MM", { max: 7 }),
    lineIds: optionalArray({ errorMessage: 'lineIds must be an array' }),
    classOverride: nullableString({ trim: true, max: 60 }),
    glOverride: nullableNumber({ min: 1000, max: 99999, integer: true, errorMessage: 'glOverride must be a GL account number' }),
};

// PUT /nri-billing/rules — the entity's channel rules as one ordered list. The
// nested condition shape is checked in the controller (normalizeRule).
const rules = {
    entity: enumOf(['CA', 'US'], "entity must be 'CA' or 'US'"),
    rules: requiredArray({ errorMessage: 'rules must be an array', missingMessage: "'rules' is required" }),
};

// POST /nri-billing/order-data/sync — optional date range (defaults in the controller)
const orderSync = {
    entity: enumOf(['CA', 'US'], "entity must be 'CA' or 'US'"),
    from: isoDate("'from' must be YYYY-MM-DD"),   // optional — isoDate allows null/absent
    to: isoDate("'to' must be YYYY-MM-DD"),
};

// PUT /nri-billing/gl-codes — service → GL for open files; rows checked in the controller
const glCodes = {
    entity: enumOf(['CA', 'US'], "entity must be 'CA' or 'US'"),
    month: requiredString("'month' (YYYY-MM) is required", { max: 7 }),
    services: requiredArray({ errorMessage: 'services must be an array', missingMessage: "'services' is required" }),
};

// POST /nri-billing/files/:id/confirm — the review's answers; rows checked in the controller
const confirmFile = {
    services: requiredArray({ errorMessage: 'services must be an array', missingMessage: "'services' is required" }),
};

module.exports = { updateFile, override, rules, orderSync, glCodes, confirmFile };
