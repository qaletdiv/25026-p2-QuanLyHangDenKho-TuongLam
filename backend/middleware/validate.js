/**
 * validate(schema) — Joi validation middleware factory.
 *
 * Usage in routes:
 *   router.post('/', requireAuth, validate(bookingSchemas.create), asyncWrap(controller.create));
 *
 * On failure: 400 with { success: false, error: 'Validation failed', details: [{field, message}] }
 * On success: req.body is replaced with the Joi-coerced value (type conversions applied).
 *
 * Options:
 *   allowUnknown: true  — extra fields pass through so partial updates work correctly.
 *   abortEarly: false   — collect ALL errors, not just the first.
 *   convert: true       — coerce strings to numbers/booleans where schema expects them.
 */
const Joi = require('joi');

function validate(schema) {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.body, {
            abortEarly: false,
            allowUnknown: true,
            convert: true,
        });

        if (error) {
            const err = new Error('Validation failed');
            err.statusCode = 400;
            err.details = error.details.map(d => ({
                field: d.path.join('.'),
                message: d.message.replace(/"/g, "'"),
            }));
            return next(err);
        }

        req.body = value;
        next();
    };
}

module.exports = validate;
