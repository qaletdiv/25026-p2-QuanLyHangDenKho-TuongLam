'use strict';

// NRI invoice verification — mounted at /nri-invoices. Fully ADDITIVE: owns
// data/nri/* and reads nothing from sms_* / mainline_* / po_*.
//
// Authorization: the whole module takes `landed_costs` (Admin + Logistics only),
// reads included. Warehouse rate cards, per-line charges and GL coding are the
// same class of commercially sensitive finance data the Landed Costs module
// gates the same way, and no page a Vendor or Freight Forwarder can open fetches
// these routes — so gating reads breaks no flow. Deliberately NOT a new
// permission key: no role file needs editing to deploy this.

const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../../middleware/errorHandler');
const requirePermission = require('../../middleware/requirePermission');
const upload = require('../../middleware/upload');
const controller = require('./nriInvoiceController');

const requireInvoices = requirePermission('landed_costs');

// The upload carries two documents: the detail workbook (the SOURCE) and the
// invoice PDF (the SUMMARY, and the only place the invoice number exists).
const documents = upload.fields([
  { name: 'detail', maxCount: 1 },
  { name: 'invoice', maxCount: 1 },
]);

// Master data — the two validators
router.get('/charge-codes',       requireInvoices, asyncWrap(controller.getChargeCodes));
router.post('/charge-codes/sync', requireInvoices, asyncWrap(controller.syncChargeCodes));
router.get('/rate-card',          requireInvoices, asyncWrap(controller.getRateCard));

// Order master — the input the CLASS depends on (channel x geography x
// marketplace). Coverage is the limiting factor on class accuracy, so it is
// inspectable and refreshable without a restart.
router.get('/order-data',          requireInvoices, asyncWrap(controller.getOrderData));
router.post('/order-data/refresh', requireInvoices, asyncWrap(controller.refreshOrderData));

// Cross-invoice analysis (cost per GL + the checks a single invoice can't see).
// Declared before /:id so "summary" is never read as an invoice id.
router.get('/summary',            requireInvoices, asyncWrap(controller.summary));

// Reconcile without saving — the reviewer's screen
router.post('/preview',           requireInvoices, documents, asyncWrap(controller.preview));

// Load / read / submit
router.get('/',                   requireInvoices, asyncWrap(controller.list));
router.post('/',                  requireInvoices, documents, asyncWrap(controller.create));
router.get('/:id',                requireInvoices, asyncWrap(controller.get));
router.post('/:id/submit',        requireInvoices, asyncWrap(controller.submit));
router.delete('/:id',             requireInvoices, asyncWrap(controller.remove));

// Per-line coding decision, keyed on (invoice_no, seq) — stable within an invoice
router.put('/:invoiceNo/lines/:seq', requireInvoices, asyncWrap(controller.setOverride));

module.exports = router;
