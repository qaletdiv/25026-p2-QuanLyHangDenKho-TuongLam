const Joi = require('joi');

const permissionKey = Joi.string().trim().min(1);

const create = Joi.object({
    name:        Joi.string().trim().min(1).required(),
    description: Joi.string().trim().allow('').optional(),
    permissions: Joi.array().items(permissionKey).required(),
});

const update = Joi.object({
    name:        Joi.string().trim().min(1).optional(),
    description: Joi.string().trim().allow('').optional(),
    permissions: Joi.array().items(permissionKey).optional(),
});

module.exports = { create, update };
