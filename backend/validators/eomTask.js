const Joi = require('joi');

const taskSchema = Joi.object({
    month:       Joi.string().allow('', null),
    title:       Joi.string().min(1).required().messages({ 'any.required': "Each task must have a 'title'" }),
    description: Joi.string().allow('', null),
    status:      Joi.string().allow('', null),
    due_date:    Joi.string().allow('', null),
    assignee:    Joi.string().allow('', null),
}).unknown(true);

const bulkCreate = Joi.array().items(taskSchema).min(1).required().messages({
    'array.base':     'Request body must be an array of tasks',
    'array.min':      'At least one task is required',
    'any.required':   'Request body must be an array of tasks',
});

const update = Joi.object({
    status:   Joi.string().allow('', null),
    title:    Joi.string().min(1).allow(null),
    due_date: Joi.string().allow('', null),
    assignee: Joi.string().allow('', null),
}).unknown(true);

module.exports = { bulkCreate, update };
