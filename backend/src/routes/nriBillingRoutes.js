'use strict';

// NRI billing — rate cards, the year's NRI invoice reports, cost per GL by
// channel. Mounted at /nri-billing. See controllers/nriBillingController.js.
//
// Gated on `landed_costs` throughout, reads included — the same finance audience
// and the same choice /nri-invoices makes (rate cards and per-line 3PL charges
// are commercially sensitive). No new permission key, so no role edit to deploy.

const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middlewares/errorHandler');
const requirePermission = require('../middlewares/requirePermission');
const upload = require('../middlewares/upload');
const validate = require('../middlewares/validate');
const schemas = require('../validators/nriBillingValidator');
const controller = require('../controllers/nriBillingController');

const gate = requirePermission('landed_costs');
const oneFile = upload.single('file');

router.get('/rate-cards',          gate, asyncWrap(controller.getRateCards));
router.post('/rate-cards',         gate, oneFile, asyncWrap(controller.uploadRateCard));

router.get('/files',               gate, asyncWrap(controller.listFiles));
router.post('/files',              gate, oneFile, asyncWrap(controller.uploadFile));
router.get('/files/:id/review',    gate, asyncWrap(controller.fileReview));
router.post('/files/:id/confirm',  gate, validate(schemas.confirmFile), asyncWrap(controller.confirmFile));
router.get('/files/:id/original',  gate, asyncWrap(controller.downloadOriginal));
router.patch('/files/:id',         gate, validate(schemas.updateFile), asyncWrap(controller.updateFile));
router.delete('/files/:id',        gate, asyncWrap(controller.removeFile));

// order data — the Order Type lookup — pulled from NetSuite Item Fulfillments (read-only)
router.get('/order-data',          gate, asyncWrap(controller.orderDataStatus));
router.post('/order-data/sync',    gate, validate(schemas.orderSync), asyncWrap(controller.syncOrderData));

router.get('/rules',              gate, asyncWrap(controller.getRules));
router.put('/rules',              gate, validate(schemas.rules), asyncWrap(controller.saveRules));
router.delete('/rules/month',     gate, asyncWrap(controller.clearRuleMonth));

router.get('/gl-codes',           gate, asyncWrap(controller.getGlCodes));
router.put('/gl-codes',           gate, validate(schemas.glCodes), asyncWrap(controller.saveGlCodes));
router.delete('/gl-codes',        gate, asyncWrap(controller.clearGlCodes));

router.get('/results',             gate, asyncWrap(controller.results));
router.get('/lines',               gate, asyncWrap(controller.lines));
router.put('/lines/override',      gate, validate(schemas.override), asyncWrap(controller.setOverride));

module.exports = router;
