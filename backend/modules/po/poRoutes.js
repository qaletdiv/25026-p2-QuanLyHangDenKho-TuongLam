'use strict';

// Shared PO hierarchy routes (Phase 1, read path). Mounted at /po so the legacy
// /purchase-orders endpoint keeps serving the running app during the parallel
// build; cutover (Phase 6) repoints the frontend here and retires the old route.
const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../../middleware/errorHandler');
const requireAdmin = require('../../middleware/requireAdmin');
const poController = require('./poController');
const orderIntentController = require('./poOrderIntentController');
const netsuiteSyncController = require('./netsuiteSyncController');

// POST before the /:trn GETs so "sync" isn't captured as a trn param
router.post('/sync/netsuite',     requireAdmin, asyncWrap(netsuiteSyncController.syncNetSuite));
router.get('/legs',               asyncWrap(poController.getLegs));   // flat PO-split list (before /:trn)
router.get('/leg-lines',          asyncWrap(poController.getAllLegLines)); // all SKU allocations (download)
router.get('/legs/:id',           asyncWrap(poController.getLeg));    // one leg + its SKU line items
router.get('/',                   asyncWrap(poController.getAll));
router.get('/:trn',               asyncWrap(poController.getOne));
router.get('/:trn/order-intent',  asyncWrap(orderIntentController.getOrderIntent));

module.exports = router;
