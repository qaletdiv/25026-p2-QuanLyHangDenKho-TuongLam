'use strict';

const { isoDate, requiredString } = require('./rules');

// ⚠️ TOP-LEVEL ARRAY bodies. '' is the body itself, '*.field' each element.
// All master-data PUT bodies must be an array of objects with at least a 'name'
// field. This prevents garbage or a plain string from overwriting a table.
const masterDataArray = {
    '': { isArray: { errorMessage: 'Request body must be an array' } },
    '*.name': requiredString("Each entry must have a non-empty 'name'"),
};

// Production schedules are keyed by seasonId (no 'name'): one row per season,
// two ISO-date cutoffs (nullable — a season may not have gates set yet).
const productionScheduleArray = {
    '': { isArray: { errorMessage: 'Request body must be an array' } },
    '*.seasonId': requiredString("Each entry must have a 'seasonId'"),
    '*.ontimeBy': isoDate(),
    '*.atriskBy': isoDate(),
};

// New-season creation (Settings → Production Schedule): just the season code.
const seasonCreate = {
    code: {
        exists: { options: { values: 'undefined' }, errorMessage: "Season 'code' is required (e.g. SS27)" },
        isString: { errorMessage: "Season 'code' is required (e.g. SS27)" },
        trim: true,
        notEmpty: { errorMessage: "Season 'code' is required (e.g. SS27)" },
        isLength: { options: { min: 2, max: 20 }, errorMessage: "Season 'code' must be 2-20 characters" },
    },
};

module.exports = { masterDataArray, productionScheduleArray, seasonCreate };
