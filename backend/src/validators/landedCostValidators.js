'use strict';

const { requiredString, requiredNumber } = require('./rules');

// ⚠️ These two bodies are TOP-LEVEL ARRAYS, not objects. In checkSchema the
// empty key '' addresses the body itself and '*.field' each element — the same
// shape Joi expressed as `Joi.array().items(row)`.

// PUT /landed-costs/rates — whole-table replace (mirrors master-data editors).
const ratesUpdate = {
  '': { isArray: { errorMessage: 'Request body must be an array' } },
  '*.id': requiredString("each rate row needs an 'id'"),
  '*.module': {
    exists: { options: { values: 'undefined' }, errorMessage: "'module' must be 'sms' or 'mainline'" },
    isIn: { options: [['sms', 'mainline']], errorMessage: "'module' must be 'sms' or 'mainline'" },
  },
  '*.freightPct': requiredNumber({ min: 0, max: 1000, errorMessage: "'freightPct' must be between 0 and 1000" }),
  '*.dutyPct': requiredNumber({ min: 0, max: 1000, errorMessage: "'dutyPct' must be between 0 and 1000" }),
};

// PUT /landed-costs/{sms,mainline}/commissions — per-supplier commission % of CI
// value (whole-table replace, per module). Kept separate from rates: commission
// is supplier-scoped, not module-scoped (e.g. Pratibha 1.5%).
const commissionsUpdate = {
  '': { isArray: { errorMessage: 'Request body must be an array' } },
  '*.id': requiredString("each commission row needs an 'id'"),
  '*.supplierId': requiredString("each commission row needs a 'supplierId'"),
  '*.commissionPct': requiredNumber({ min: 0, max: 100, errorMessage: "'commissionPct' must be between 0 and 100" }),
};

module.exports = { ratesUpdate, commissionsUpdate };
