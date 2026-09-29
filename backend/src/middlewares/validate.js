/**
 * validate(schema) — express-validator middleware factory.
 *
 * Usage in routes:
 *   router.post('/', validate(bookingSchemas.create), asyncWrap(controller.create));
 *
 * On failure: 400 with { success: false, error: 'Validation failed', details: [{field, message}] }
 * On success: sanitizers have written coerced values back into req.body.
 *
 * `schema` is a `checkSchema` object, so the validator files stay declarative
 * data and every route reads the same one-line `validate(...)`.
 *
 * ⚠️ THREE BEHAVIOURS THIS LAYER GUARANTEES, all load-bearing:
 *
 *   ALL errors, not the first — `checkSchema` collects every failing field, and
 *                       the frontend renders the whole list into the form.
 *   Unknown keys PASS THROUGH — express-validator only inspects the paths it is
 *                       given and never strips, which is what makes partial
 *                       updates work. ⚠️ Do NOT add `checkExact()` to "tighten"
 *                       this; the controllers rely on unknown keys surviving.
 *   Values are COERCED — '5' reaches the controller as 5 and 'true' as true.
 *                       This is NOT automatic: it is why the rules in
 *                       validators/rules.js pair every numeric check with
 *                       `toInt`/`toFloat` and every boolean with `toBoolean`.
 *                       Drop a sanitizer and a controller silently receives a
 *                       string where it did arithmetic.
 *
 * `checkSchema` is called ONCE per route at wire-up time, not per request.
 */
const { checkSchema, validationResult } = require('express-validator');

function validate(schema) {
    // ['body'] confines every field lookup to req.body. Without it
    // express-validator would also look in query/params/headers and could
    // satisfy a required field from the wrong place.
    const chains = checkSchema(schema, ['body']);

    return async (req, res, next) => {
        try {
            for (const chain of chains) await chain.run(req);
        } catch (e) {
            return next(e);
        }

        const result = validationResult(req);
        if (!result.isEmpty()) {
            const err = new Error('Validation failed');
            err.statusCode = 400;
            // ⚠️ onlyFirstError: ONE message per field.
            //
            // A rule like `requiredString` is three checks (exists + isString +
            // notEmpty) and an absent field trips all three, so without this the
            // client gets "'supplierId' is required" three times over, and the
            // frontend renders `details` straight into the form. `bail` would be
            // the per-field equivalent but is NOT a valid checkSchema key in
            // express-validator 7 — accepted silently and ignored (measured:
            // still 3 errors).
            err.details = result.array({ onlyFirstError: true }).map((d) => ({
                // `path` is '' for a root-level check (the master-data PUTs send a
                // top-level array).
                field: d.path === undefined ? '' : d.path,
                message: d.msg,
            }));
            return next(err);
        }

        next();
    };
}

module.exports = validate;
