'use strict';

// SMS module routes — mounted at /sms. Fully separate from /mainline and /po:
// this module reads/writes ONLY the sms_* dataset (+ shared master data).
// Phase 4 adds /sms/sync/netsuite (the SMS-only NetSuite sync) here.

const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../../middleware/errorHandler');
const requireAuth = require('../../middleware/auth');
const requireAdmin = require('../../middleware/requireAdmin');
const validate = require('../../middleware/validate');
const upload = require('../../middleware/upload');
const poController = require('./smsPoController');
const shipmentController = require('./smsShipmentController');
const packingController = require('./smsPackingController');
const receiptController = require('./smsReceiptController');
const syncService = require('./smsNetsuiteSyncService');
const schemas = require('./smsValidators');

// The SMS-only NetSuite sync (custbody_tt_po_type='smm' POs + their Item
// Receipts). Unrelated to the deactivated mainline sync under /po.
router.post('/sync/netsuite', requireAdmin, asyncWrap(async (req, res) => {
  res.json({ ok: true, source: 'netsuite', ...(await syncService.sync()) });
}));

// Manual trigger for the FedEx tracking poll (also runs on a 4h cron). Appends
// scan events; status stays derived — safe to run any time.
router.post('/tracking/poll', requireAuth, asyncWrap(async (req, res) => {
  res.json({ ok: true, source: 'fedex', ...(await require('./smsTrackingService').poll()) });
}));

// SMS purchase orders (read-only — the SMS NetSuite sync owns writes)
router.get('/pos',            asyncWrap(poController.getAll));
router.get('/po-lines',       asyncWrap(poController.getAllLines));   // all SKU order lines (download)
router.get('/pos/:poNumber',  asyncWrap(poController.getOne));

// Shipments (consignments) — vendor self-service, guarded server-side
router.get('/shipments',                    asyncWrap(shipmentController.getAll));
router.post('/shipments',      requireAuth, validate(schemas.shipmentCreate), asyncWrap(shipmentController.create));
router.get('/shipments/:id',                asyncWrap(shipmentController.getOne));
router.put('/shipments/:id',   requireAuth, validate(schemas.shipmentUpdate), asyncWrap(shipmentController.update));
router.delete('/shipments/:id', requireAuth, asyncWrap(shipmentController.remove));

// Shipping data — vendor uploads one packing Excel per consignment → carton × SKU
// detail + generated CI/packing-list documents (combined + per-PO).
router.post('/shipments/:id/shipping-data', requireAuth, upload.single('file'), asyncWrap(packingController.uploadShippingData));
router.get('/shipments/:id/documents', asyncWrap(packingController.getDocuments));

// Item Receipt LINES sync from NetSuite (smsNetsuiteSync writes sms_item_receipts
// /_lines) and feed the PO detail's reconciliation (smsService.reconcilePo) — no
// line write endpoints. The only portal-owned write is the shipment↔IR MATCH
// (matched_shipment_id), reactivated 2026-07-22 to target landed-cost pushes.
router.get('/shipments/:id/receipt-matches', asyncWrap(receiptController.suggestForShipment));
router.post('/receipts/manual-match', requireAuth, validate(schemas.receiptManualMatch), asyncWrap(receiptController.manualMatch));
router.post('/receipts/:id/match',   requireAuth, validate(schemas.receiptMatch), asyncWrap(receiptController.setMatch));
router.delete('/receipts/:id/match', requireAuth, asyncWrap(receiptController.clearMatch));

module.exports = router;
