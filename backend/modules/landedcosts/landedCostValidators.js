'use strict';

const Joi = require('joi');

// PUT /landed-costs/rates — whole-table replace (mirrors master-data editors).
const rateRow = Joi.object({
  id: Joi.string().min(1).required(),
  module: Joi.string().valid('sms', 'mainline').required(),
  freight_pct: Joi.number().min(0).max(1000).required(),
  duty_pct: Joi.number().min(0).max(1000).required(),
});

const ratesUpdate = Joi.array().items(rateRow);

// PUT /landed-costs/{sms,mainline}/commissions — per-supplier commission % of CI
// value (whole-table replace, per module). Kept separate from rates: commission
// is supplier-scoped, not module-scoped (e.g. Pratibha 1.5%).
const commissionRow = Joi.object({
  id: Joi.string().min(1).required(),
  supplier_id: Joi.string().min(1).required(),
  commission_pct: Joi.number().min(0).max(100).required(),
});

const commissionsUpdate = Joi.array().items(commissionRow);

module.exports = { ratesUpdate, commissionsUpdate };
