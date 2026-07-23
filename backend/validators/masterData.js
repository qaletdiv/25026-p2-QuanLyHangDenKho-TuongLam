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

// Production schedules are keyed by season_id (no 'name'): one row per season,
// two ISO-date cutoffs (nullable — a season may not have gates set yet).
const isoDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
    .custom((v, helpers) => (isNaN(new Date(v).getTime()) ? helpers.error('any.invalid') : v))
    .messages({
        'string.pattern.base': 'Dates must be YYYY-MM-DD',
        'any.invalid': 'Not a valid calendar date',
    });
const productionScheduleArray = Joi.array()
    .items(
        Joi.object({
            season_id: Joi.string().min(1).required(),
            ontime_by: isoDate.allow(null, ''),
            atrisk_by: isoDate.allow(null, ''),
        }).unknown(true)
    )
    .required()
    .messages({
        'array.base': 'Request body must be an array',
        'any.required': 'Request body must be an array',
    });

// New-season creation (Settings → Production Schedule): just the season code.
const seasonCreate = Joi.object({
    code: Joi.string().trim().min(2).max(20).required().messages({
        'string.empty': "Season 'code' is required (e.g. SS27)",
        'any.required': "Season 'code' is required (e.g. SS27)",
    }),
});

module.exports = { masterDataArray, productionScheduleArray, seasonCreate };
