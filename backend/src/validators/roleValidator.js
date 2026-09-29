'use strict';

const { requiredString, optionalString, blankableString, requiredArray, optionalArray } = require('./rules');

// Permission keys: a non-empty string per entry. The CONTROLLER checks them
// against the live key list — an unknown key there is a 400, not a silent grant.
const permissionKey = { trim: true, notEmpty: { errorMessage: 'each permission must be a non-empty string' } };

const create = {
    name: requiredString("'name' is required"),
    description: blankableString(),          // clearable to '', but not null
    permissions: requiredArray({ errorMessage: "'permissions' must be an array" }),
    'permissions.*': permissionKey,
};

const update = {
    name: optionalString("'name' must not be empty"),
    description: blankableString(),
    permissions: optionalArray({ errorMessage: "'permissions' must be an array" }),
    'permissions.*': permissionKey,
};

module.exports = { create, update };
