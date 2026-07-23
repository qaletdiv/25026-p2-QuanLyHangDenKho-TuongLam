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

module.exports = { ratesUpdate };
