const Joi = require('joi');

// All master-data PUT bodies must be an array of objects with at least a 'name' field.
// This prevents garbage or a plain string from overwriting a JSON file.
const masterDataArray = Joi.array()
    .items(
        Joi.object({
            name: Joi.string().min(1).required().messages({
                'string.empty': "Each entry must have a non-empty 'name'",
                'any.required': "Each entry must have a 'name'",
            }),
        }).unknown(true)
    )
    .required()
    .messages({
        'array.base': 'Request body must be an array',
        'any.required': 'Request body must be an array',
    });

module.exports = { masterDataArray };
