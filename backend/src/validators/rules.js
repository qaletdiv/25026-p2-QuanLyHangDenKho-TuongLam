'use strict';
/**
 * Shared field rules, in express-validator's `checkSchema` format.
 *
 * These replace Joi fragments that were copy-pasted across the validators — the
 * ISO-date check existed five times, character for character.
 *
 * ⚠️ KEEP THIS LAYER (Lam, 2026-09-28). It was flagged at the port as arguably
 * re-creating a little of Joi on top of express-validator, and kept anyway,
 * deliberately. Two reasons:
 *
 *   1. Without it the nine validator files roughly double through repetition —
 *      every nullable string becomes four lines of `optional`/`isString`/
 *      `trim`/`isLength` at each of its ~55 call sites.
 *   2. It is the ONLY place the optional/nullable/blankable distinction below
 *      is stated once. Spelling that out per field is exactly how the 15
 *      regressions the differential test caught got written in the first place.
 *
 * So the alternative — idiomatic bare `checkSchema` entries everywhere — was
 * considered and declined. Do not inline these helpers back into the callers.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ OPTIONAL, NULLABLE AND BLANKABLE ARE THREE DIFFERENT THINGS.
 *
 * Joi distinguished them and so must this. Collapsing them is not a style
 * choice — it silently widens what the API accepts, and a differential test of
 * the old schemas against the new ones caught exactly that on 15 fields.
 *
 *   Joi                                    | undefined | null | ''  | helper
 *   ---------------------------------------|-----------|------|-----|------------------
 *   .string().required()                   |     ✗     |  ✗   |  ✗  | requiredString
 *   .string().min(1).optional()            |     ✓     |  ✗   |  ✗  | optionalString
 *   .string().allow('').optional()         |     ✓     |  ✗   |  ✓  | blankableString
 *   .string().allow(null, '')              |     ✓     |  ✓   |  ✓  | nullableString
 *   .number().min(0).allow(null)           |     ✓     |  ✓   |  —  | nullableNumber
 *   .boolean()                             |     ✓     |  ✗   |  —  | optionalBoolean
 *
 * `optional: true` skips ONLY undefined. `optional: {values:'null'}` skips
 * undefined AND null. Reach for the second one only where Joi wrote
 * `.allow(null)`.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Joi did NOT coerce a number into a string field (`Joi.string()` rejects `5`),
 * so neither do these — verified against the old schemas rather than assumed.
 */

/** Skips undefined only — Joi `.optional()`. */
const OPTIONAL = true;
/** Skips undefined AND null — Joi `.allow(null)`. */
const NULLABLE = { options: { values: 'null' } };

/**
 * ISO calendar date, `YYYY-MM-DD`, nullable and blankable (every Joi `isoDate`
 * in this codebase carried `.allow(null, '')`).
 *
 * The regex catches the SHAPE and the Date check catches impossible dates like
 * 2026-13-45, which parse to Invalid Date. Both Joi messages are preserved, and
 * a single `custom` is used (rather than `matches` + `custom`) so a malformed
 * value yields ONE error with the right message instead of two.
 */
function isoDate(shapeMessage = 'Dates must be YYYY-MM-DD') {
    return {
        optional: NULLABLE,
        custom: {
            options: (v) => {
                if (v === '') return true;
                if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(shapeMessage);
                if (Number.isNaN(new Date(v).getTime())) throw new Error('Not a valid calendar date');
                return true;
            },
        },
    };
}

function withLength(rule, { min, max, lengthMessage }) {
    if (min === undefined && max === undefined) return rule;
    return {
        ...rule,
        isLength: {
            options: { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) },
            errorMessage: lengthMessage || `must be at most ${max} characters`,
        },
    };
}

/** Required, present and non-empty. Joi `.string().trim().min(1).required()`. */
function requiredString(errorMessage, { max } = {}) {
    return withLength({
        exists: { options: { values: 'undefined' }, errorMessage },
        isString: { errorMessage },
        trim: true,
        notEmpty: { errorMessage },
    }, { max });
}

/** Optional; non-empty WHEN PRESENT. null and '' are REJECTED. Joi `.string().min(1).optional()`. */
function optionalString(errorMessage, { max, trim = true } = {}) {
    const rule = { optional: OPTIONAL, isString: { errorMessage }, notEmpty: { errorMessage } };
    if (trim) rule.trim = true;
    return withLength(rule, { max });
}

/** Optional; '' allowed, null REJECTED. Joi `.string().allow('').optional()`. */
function blankableString({ max, trim = true } = {}) {
    const rule = { optional: OPTIONAL, isString: { errorMessage: 'must be a string' } };
    if (trim) rule.trim = true;
    return withLength(rule, { max });
}

/** Optional; null AND '' allowed. Joi `.string().allow(null, '')`. */
function nullableString({ max, trim = false } = {}) {
    const rule = { optional: NULLABLE, isString: { errorMessage: 'must be a string' } };
    if (trim) rule.trim = true;
    return withLength(rule, { max });
}

/** Number, null allowed. Joi `.number().min(0).allow(null)`. Coerced like convert:true. */
function nullableNumber({ min = 0, max, integer = false, errorMessage } = {}) {
    const options = { min, ...(max === undefined ? {} : { max }) };
    const msg = errorMessage || `must be a number of at least ${min}`;
    return integer
        ? { optional: NULLABLE, isInt: { options, errorMessage: msg }, toInt: true }
        : { optional: NULLABLE, isFloat: { options, errorMessage: msg }, toFloat: true };
}

/** Required number. Joi `.number().min(0).required()`. */
function requiredNumber({ min = 0, max, integer = false, errorMessage, missingMessage } = {}) {
    const options = { min, ...(max === undefined ? {} : { max }) };
    const msg = errorMessage || `must be a number of at least ${min}`;
    const rule = { exists: { options: { values: 'undefined' }, errorMessage: missingMessage || msg } };
    if (integer) { rule.isInt = { options, errorMessage: msg }; rule.toInt = true; } else { rule.isFloat = { options, errorMessage: msg }; rule.toFloat = true; }
    return rule;
}

/**
 * One of a fixed vocabulary. `nullable` mirrors whether the Joi field carried
 * `.allow('', null)` — the mainline BOOKING status did, the SHIPMENT status did
 * not, and that difference is load-bearing.
 */
function enumOf(values, errorMessage, { nullable = false } = {}) {
    return {
        optional: nullable ? NULLABLE : OPTIONAL,
        custom: {
            options: (v) => {
                if (nullable && v === '') return true;
                if (!values.includes(v)) throw new Error(errorMessage);
                return true;
            },
        },
    };
}

/** Boolean, coerced like Joi's convert:true ('true'/1 → true). null REJECTED, as Joi did. */
const optionalBoolean = { optional: OPTIONAL, isBoolean: { errorMessage: 'must be true or false' }, toBoolean: true };

/** Joi `.array().items(...).min(n).required()` — the array itself. */
function requiredArray({ min, errorMessage, missingMessage } = {}) {
    return {
        exists: { options: { values: 'undefined' }, errorMessage: missingMessage || errorMessage },
        isArray: { options: min === undefined ? {} : { min }, errorMessage },
    };
}

/** Joi `.array()` optional — null REJECTED unless `nullable`. */
function optionalArray({ min, errorMessage, nullable = false } = {}) {
    return {
        optional: nullable ? NULLABLE : OPTIONAL,
        isArray: { options: min === undefined ? {} : { min }, errorMessage },
    };
}

module.exports = {
    OPTIONAL, NULLABLE, isoDate,
    requiredString, optionalString, blankableString, nullableString,
    requiredNumber, nullableNumber,
    enumOf, optionalBoolean, requiredArray, optionalArray,
};
