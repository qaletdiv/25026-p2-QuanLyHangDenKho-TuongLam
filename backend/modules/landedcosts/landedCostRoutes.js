'use strict';

// Landed Costs module routes — mounted at /landed-costs. Fully ADDITIVE:
// reads the SMS dataset + shared master data, writes ONLY its own tables
// (landed_cost_rates, landed_costs). No sms_* / mainline_* rows are mutated.

const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../../middleware/errorHandler');
const requireAuth = require('../../middleware/auth');
const requireAdmin = require('../../middleware/requireAdmin');
const validate = require('../../middleware/validate');
const controller = require('./landedCostController');
const { ratesUpdate } = require('./landedCostValidators');

// Rates (editable master data: module → freight % / duty %)
router.get('/rates',  asyncWrap(controller.getRates));
router.put('/rates',  requireAuth, validate(ratesUpdate), asyncWrap(controller.putRates));

// SMS landed-cost read model + posting
router.get('/sms',                        asyncWrap(controller.getSms));
router.post('/sms/:shipmentId/post',      requireAuth, asyncWrap(controller.postSms));

// NetSuite Item-Receipt push (Phase 2). Preview sends nothing; push is guarded
// off by default (LANDED_COST_NS_PUSH=enabled to arm — sandbox only).
router.get('/sms/:shipmentId/netsuite-preview',  requireAuth, asyncWrap(controller.netsuitePreviewSms));
router.post('/sms/:shipmentId/netsuite-push',    requireAdmin, asyncWrap(controller.netsuitePushSms));

// Unpost (corrections) — removes the posted snapshot only
router.delete('/:id',                     requireAuth, asyncWrap(controller.unpost));

module.exports = router;
