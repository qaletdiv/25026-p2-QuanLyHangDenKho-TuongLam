'use strict';

// Landed Costs module routes — mounted at /landed-costs. Fully ADDITIVE:
// reads the SMS dataset + shared master data, writes ONLY its own tables
// (landed_cost_rates, landed_costs). No sms_* / mainline_* rows are mutated.

const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../../middleware/errorHandler');
const requireAdmin = require('../../middleware/requireAdmin');
const requirePermission = require('../../middleware/requirePermission');
const validate = require('../../middleware/validate');
const controller = require('./landedCostController');
const { ratesUpdate, commissionsUpdate } = require('./landedCostValidators');

// Authorization: the WHOLE module requires `landed_costs` (Admin + Logistics
// only) — reads included, not just writes. Freight/duty rates, commission
// percentages and the posted cost book are commercially sensitive, and unlike the
// transactional tables nothing here is fetched by a page a Vendor or Freight
// Forwarder can open, so gating reads on the nav key breaks no flow. This is what
// stops a Vendor curling /landed-costs/sms and reading the entire cost book.
const requireLandedCosts = requirePermission('landed_costs');

// Rates (editable master data: module → freight % / duty %)
router.get('/rates',  requireLandedCosts, asyncWrap(controller.getRates));
router.put('/rates',  requireLandedCosts, validate(ratesUpdate), asyncWrap(controller.putRates));

// Commission rates (per-supplier % of CI — SMS and mainline kept SEPARATE)
router.get('/sms/commissions',       requireLandedCosts, asyncWrap(controller.getSmsCommissions));
router.put('/sms/commissions',       requireLandedCosts, validate(commissionsUpdate), asyncWrap(controller.putSmsCommissions));
router.get('/mainline/commissions',  requireLandedCosts, asyncWrap(controller.getMlCommissions));
router.put('/mainline/commissions',  requireLandedCosts, validate(commissionsUpdate), asyncWrap(controller.putMlCommissions));

// SMS landed-cost read model + posting
router.get('/sms',                        requireLandedCosts, asyncWrap(controller.getSms));
router.post('/sms/:shipmentId/post',      requireLandedCosts, asyncWrap(controller.postSms));

// NetSuite Item-Receipt push (Phase 2). Preview sends nothing; push is guarded
// off by default (LANDED_COST_NS_PUSH=enabled to arm — sandbox only).
router.get('/sms/:shipmentId/netsuite-preview',  requireLandedCosts, asyncWrap(controller.netsuitePreviewSms));
router.post('/sms/:shipmentId/netsuite-push',    requireAdmin, asyncWrap(controller.netsuitePushSms));

// Mainline landed-cost read model + posting (amounts entered on the shipment;
// per-PO split + IR match derived here; Post pushes to NetSuite).
router.get('/mainline',                             requireLandedCosts, asyncWrap(controller.getMainline));
router.post('/mainline/:shipmentId/post',           requireLandedCosts, asyncWrap(controller.postMainline));
router.get('/mainline/:shipmentId/netsuite-preview', requireLandedCosts, asyncWrap(controller.netsuitePreviewMainline));
router.post('/mainline/:shipmentId/netsuite-push',  requireAdmin, asyncWrap(controller.netsuitePushMainline));

// Unpost (corrections) — removes the posted snapshot only
router.delete('/:id',                     requireLandedCosts, asyncWrap(controller.unpost));

module.exports = router;
