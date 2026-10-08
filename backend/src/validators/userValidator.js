'use strict';

// users is 3NF: the role, supplier and courier arrive as IDS. The controller
// checks each id against its master list (roles / suppliers / couriers), so a
// role added in settings works immediately without touching this file.

const { requiredString, optionalString, nullableString, optionalBoolean, OPTIONAL } = require('./rules');

// ⚠️ The address is stored AS TYPED: no lowercasing, no dot-stripping.
// `normalizeEmail`'s defaults would rewrite it, so it is not applied here.
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
    roleId: requiredString("'roleId' is required"),
    supplierId: nullableString({ trim: true }),   // Vendor only — nullable + clearable
    courierId: nullableString({ trim: true }),    // Freight Forwarder only
};

const update = {
    name: optionalString("'name' must not be empty"),
    email: { optional: OPTIONAL, isString: { errorMessage: "'email' must be a string" }, ...EMAIL_CHECKS },
    password: {
        optional: OPTIONAL,
        isString: { errorMessage: "'password' must be a string" },
        isLength: { options: { min: 8 }, errorMessage: 'password must be at least 8 characters' },
    },
    roleId: optionalString("'roleId' must not be empty"),
    supplierId: nullableString({ trim: true }),
    courierId: nullableString({ trim: true }),
    mustChangePassword: optionalBoolean,
};

module.exports = { create, update };
