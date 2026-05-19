const Joi = require('joi');

// Role name validation is intentionally kept as a plain string here.
// The controller validates the role against the live roles.json list so that
// adding a new role in settings immediately works without touching this file.

const create = Joi.object({
    name:     Joi.string().trim().min(1).required(),
    email:    Joi.string().email().required(),
    password: Joi.string().min(8).required(),
    role:     Joi.string().trim().min(1).required(),
    supplier: Joi.string().trim().allow('', null).optional(),
});

const update = Joi.object({
    name:     Joi.string().trim().min(1).optional(),
    email:    Joi.string().email().optional(),
    password: Joi.string().min(8).optional(),
    role:     Joi.string().trim().min(1).optional(),
    supplier: Joi.string().trim().allow('', null).optional(),
    must_change_password: Joi.boolean().optional(),
});

module.exports = { create, update };
