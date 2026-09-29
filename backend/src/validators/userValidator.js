'use strict';

// Role name validation is intentionally kept as a plain string here.
// The controller validates the role against the live roles list so that adding
// a new role in settings immediately works without touching this file.

const { requiredString, optionalString, nullableString, optionalBoolean, OPTIONAL } = require('./rules');

// Joi's .email() neither lowercased nor stripped dots, so neither does this —
// `normalizeEmail` defaults would otherwise rewrite the address being stored.
const EMAIL_CHECKS = {
    isEmail: { errorMessage: 'must be a valid email address' },
};

const create = {
    name: requiredString("'name' is required"),
    email: {
        exists: { options: { values: 'undefined' }, errorMessage: "'email' is required" },
        isString: { errorMessage: "'email' must be a string" },
        ...EMAIL_CHECKS,
    },
    password: {
        exists: { options: { values: 'undefined' }, errorMessage: "'password' is required" },
        isString: { errorMessage: "'password' must be a string" },
        isLength: { options: { min: 8 }, errorMessage: 'password must be at least 8 characters' },
    },
    role: requiredString("'role' is required"),
    supplier: nullableString({ trim: true }),   // Joi: .allow('', null)
};

const update = {
    name: optionalString("'name' must not be empty"),
    email: { optional: OPTIONAL, isString: { errorMessage: "'email' must be a string" }, ...EMAIL_CHECKS },
    password: {
        optional: OPTIONAL,
        isString: { errorMessage: "'password' must be a string" },
        isLength: { options: { min: 8 }, errorMessage: 'password must be at least 8 characters' },
    },
    role: optionalString("'role' must not be empty"),
    supplier: nullableString({ trim: true }),
    mustChangePassword: optionalBoolean,
};

module.exports = { create, update };
