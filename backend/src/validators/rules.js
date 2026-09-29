'use strict';
/**
 * Shared field rules, in express-validator's `checkSchema` format.
 *
 * One definition per field SHAPE, so the nine validator files stay readable.
 * The ISO-date check alone used to exist five times, character for character.
 *
 * ⚠️ KEEP THIS LAYER (Lam, 2026-09-28). It was flagged as arguably a small
 * abstraction on top of express-validator, and kept anyway, deliberately.
 * Two reasons:
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
 * Which of the three a field wants is a real decision per field. Collapsing
 * them is not a style choice — it silently widens what the API accepts, and
 * doing exactly that wrongly widened 15 fields before it was caught.
 *
 *   helper            | undefined | null | ''  | typical use
 *   ------------------|-----------|------|-----|--------------------------------
 *   requiredString    |     ✗     |  ✗   |  ✗  | supplierId, poNumber, legId
 *   optionalString    |     ✓     |  ✗   |  ✗  | a PATCH field that must be real
 *   blankableString   |     ✓     |  ✗   |  ✓  | description — clearable, not null
 *   nullableString    |     ✓     |  ✓   |  ✓  | most nullable columns
 *   nullableNumber    |     ✓     |  ✓   |  —  | units, freight, cbm
 *   requiredNumber    |     ✗     |  ✗   |  —  | qty on a CI line
 *   optionalBoolean   |     ✓     |  ✗   |  —  | priority, force_overship
 *
 * The mechanism: `optional: true` skips ONLY undefined; `optional:
 * {values:'null'}` skips undefined AND null; '' is never skipped by either and
 * has to be permitted by the rule itself. Reach for the second only when the
 * column is genuinely nullable.
 *
 * A number is NOT accepted where a string is declared — `isString` rejects `5`
 * rather than stringifying it. Deliberate, and asserted by the tests.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * (This layer arrived 2026-09-28 with express-validator. The three-way
 * distinction above is the one thing a naive port gets wrong — see
 * backend/README.md for the measured fallout.)
 */

/** Skips undefined only. */
const OPTIONAL = true;
/** Skips undefined AND null. */
const NULLABLE = { options: { values: 'null' } };

/**
 * ISO calendar date, `YYYY-MM-DD`, nullable and blankable — every date field in
 * this codebase accepts null and '' as "not set".
 *
 * The regex catches the SHAPE and the Date check catches impossible dates like
 * 2026-13-45, which parse to Invalid Date. A single `custom` is used (rather
 * than `matches` + `custom`) so a malformed value yields ONE error with the
 * right message instead of two.
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

/** Required: present, a string, and non-empty after trimming. */
function requiredString(errorMessage, { max } = {}) {
    return withLength({
        exists: { options: { values: 'undefined' }, errorMessage },
        isString: { errorMessage },
        trim: true,
        notEmpty: { errorMessage },
    }, { max });
}

/** Optional; non-empty WHEN PRESENT. null and '' are REJECTED. */
function optionalString(errorMessage, { max, trim = true } = {}) {
    const rule = { optional: OPTIONAL, isString: { errorMessage }, notEmpty: { errorMessage } };
    if (trim) rule.trim = true;
    return withLength(rule, { max });
}

/** Optional; '' allowed (the field is clearable), null REJECTED. */
function blankableString({ max, trim = true } = {}) {
    const rule = { optional: OPTIONAL, isString: { errorMessage: 'must be a string' } };
    if (trim) rule.trim = true;
    return withLength(rule, { max });
}

/** Optional; null AND '' both allowed — the usual nullable column. */
function nullableString({ max, trim = false } = {}) {
    const rule = { optional: NULLABLE, isString: { errorMessage: 'must be a string' } };
    if (trim) rule.trim = true;
    return withLength(rule, { max });
}

/** Number, null allowed. Coerced to a real number, not left as a string. */
function nullableNumber({ min = 0, max, integer = false, errorMessage } = {}) {
    const options = { min, ...(max === undefined ? {} : { max }) };
    const msg = errorMessage || `must be a number of at least ${min}`;
    return integer
        ? { optional: NULLABLE, isInt: { options, errorMessage: msg }, toInt: true }
        : { optional: NULLABLE, isFloat: { options, errorMessage: msg }, toFloat: true };
}

/** Required number. Coerced to a real number, not left as a string. */
function requiredNumber({ min = 0, max, integer = false, errorMessage, missingMessage } = {}) {
    const options = { min, ...(max === undefined ? {} : { max }) };
    const msg = errorMessage || `must be a number of at least ${min}`;
    const rule = { exists: { options: { values: 'undefined' }, errorMessage: missingMessage || msg } };
    if (integer) { rule.isInt = { options, errorMessage: msg }; rule.toInt = true; } else { rule.isFloat = { options, errorMessage: msg }; rule.toFloat = true; }
    return rule;
}

/**
 * One of a fixed vocabulary. ⚠️ `nullable` differs per field and is load-bearing:
 * the mainline BOOKING status accepts ''/null (a booking may be unstated), the
 * SHIPMENT status does not.
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

/** Boolean, coerced ('true'/1 → true). null REJECTED. */
const optionalBoolean = { optional: OPTIONAL, isBoolean: { errorMessage: 'must be true or false' }, toBoolean: true };

/** Required array (the array itself; its elements are declared as `field.*.x`). */
function requiredArray({ min, errorMessage, missingMessage } = {}) {
    return {
        exists: { options: { values: 'undefined' }, errorMessage: missingMessage || errorMessage },
        isArray: { options: min === undefined ? {} : { min }, errorMessage },
    };
}

/** Optional array — null REJECTED unless `nullable` is set. */
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
