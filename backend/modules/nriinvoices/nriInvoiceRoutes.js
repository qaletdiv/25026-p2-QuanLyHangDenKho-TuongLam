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
const validate = require('../../middleware/validate');
const nriSchemas = require('./nriInvoiceValidator');
const controller = require('./nriInvoiceController');

const requireInvoices = requirePermission('landed_costs');

// The upload carries two documents: the detail workbook (the SOURCE) and the
// invoice PDF (the SUMMARY, and the only place the invoice number exists).
const documents = upload.fields([
  { name: 'detail', maxCount: 1 },
  { name: 'invoice', maxCount: 1 },
]);

// The warehouses that bill us — one row per invoicing warehouse = one tab under
// All Invoices. Declared before /:id so "sources" is never read as an invoice id.
// A new warehouse is registered as a SHELL (uploads off until its detail-file
// layout is mapped) — see invoiceSources.js.
router.get('/sources',            requireInvoices, asyncWrap(controller.listSources));
router.post('/sources',           requireInvoices, validate(nriSchemas.source), asyncWrap(controller.addSource));
router.delete('/sources/:code',   requireInvoices, asyncWrap(controller.removeSource));

// Master data — the two validators.
//
// The legend is the GL lookup basis, and it is CONFIGURED here: the sync accepts
// an uploaded workbook (`legend`), so it no longer requires the shared drive to be
// mapped. `dryRun=true` reports the defects without adopting the file.
const legendFile = upload.fields([{ name: 'legend', maxCount: 1 }]);
router.get('/charge-codes',       requireInvoices, asyncWrap(controller.getChargeCodes));
router.post('/charge-codes/sync', requireInvoices, legendFile, asyncWrap(controller.syncChargeCodes));
router.get('/rate-card',          requireInvoices, asyncWrap(controller.getRateCard));

// Order master — the input the CLASS depends on (channel x geography x
// marketplace). Coverage is the limiting factor on class accuracy, so it is
// inspectable and refreshable without a restart.
const orderFile = upload.fields([{ name: 'file', maxCount: 1 }]);
router.get('/order-data',          requireInvoices, asyncWrap(controller.getOrderData));
// Upload the `NRI Order data` sheet (or a period CSV). UPSERTS by order number, so
// dropping in a later period tops the master up rather than replacing it.
router.post('/order-data',         requireInvoices, orderFile, asyncWrap(controller.uploadOrderData));
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

// Per-line coding decision, keyed on (invoiceNo, seq) — stable within an invoice
router.put('/:invoiceNo/lines/:seq', requireInvoices, asyncWrap(controller.setOverride));

module.exports = router;
