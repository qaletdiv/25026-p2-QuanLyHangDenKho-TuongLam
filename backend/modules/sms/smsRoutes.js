'use strict';

// SMS module routes — mounted at /sms. Fully separate from /mainline and /po:
// this module reads/writes ONLY the sms_* dataset (+ shared master data).
// Phase 4 adds /sms/sync/netsuite (the SMS-only NetSuite sync) here.

const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../../middleware/errorHandler');
const requireAdmin = require('../../middleware/requireAdmin');
const requirePermission = require('../../middleware/requirePermission');
const validate = require('../../middleware/validate');
const upload = require('../../middleware/upload');
const poController = require('./smsPoController');
const bookingController = require('./smsBookingController');
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

// ---------------------------------------------------------------------------
// Authorization. Reads sit behind the global auth gate (server.js) and are
// vendor-scoped in the controllers; WRITES additionally require a permission key.
//
// Two constraints from roles.json shape the unions below:
//  • Vendor holds `bookings` and `shipments` but NOT `booking_create_sms` — and
//    CLAUDE.md records that SMS bookings deliberately reuse the existing
//    `bookings` key rather than adding one. So vendor-reachable SMS writes must
//    accept the nav key, or the documented vendor flow breaks.
//  • There is no `shipment_create` key at all. Every role currently holds
//    `shipments`, so gating creation on it is semantically right but NOT a real
//    restriction today. Adding a dedicated key is a roles.json decision, left
//    open deliberately rather than invented here.
// ---------------------------------------------------------------------------

// Manual trigger for the FedEx tracking poll (also runs on a 4h cron). Appends
// scan events; status stays derived — safe to run any time. Costs a FedEx API
// call, so it needs more than a bare login.
router.post('/tracking/poll', requirePermission('shipment_update_status'), asyncWrap(async (req, res) => {
  res.json({ ok: true, source: 'fedex', ...(await require('./smsTrackingService').poll()) });
}));

// SMS purchase orders (read-only — the SMS NetSuite sync owns writes)
router.get('/pos',            asyncWrap(poController.getAll));
router.get('/po-lines',       asyncWrap(poController.getAllLines));   // all SKU order lines (download)
router.get('/pos/:poNumber',  asyncWrap(poController.getOne));

// Bookings — the OPTIONAL authorization step (vendor submits, Logistics approves).
// Approval creates draft shipment(s); a bookingless shipment stays the norm.
router.get('/bookings',                    asyncWrap(bookingController.getAll));
router.post('/bookings',      requirePermission('booking_create_sms', 'bookings'), validate(schemas.bookingCreate), asyncWrap(bookingController.create));
router.get('/bookings/:id',                asyncWrap(bookingController.getOne));
router.patch('/bookings/:id', requirePermission('booking_create_sms', 'bookings'), validate(schemas.bookingUpdate), asyncWrap(bookingController.update));
router.post('/bookings/:id/approve', requirePermission('booking_approve'), asyncWrap(bookingController.approve));
router.post('/bookings/:id/reject',  requirePermission('booking_approve'), asyncWrap(bookingController.reject));
// Cancel is the staff exit from an APPROVED booking (deletes untracked drafts),
// so it sits with approve rather than with the vendor's create/edit keys.
router.post('/bookings/:id/cancel',  requirePermission('booking_approve'), asyncWrap(bookingController.cancel));
router.delete('/bookings/:id', requirePermission('booking_delete'), asyncWrap(bookingController.remove));

// Shipments (consignments) — vendor self-service, guarded server-side
router.get('/shipments',                    asyncWrap(shipmentController.getAll));
// `shipments` only — see the note above: no `shipment_create` key exists, and the
// vendor entering their own consignment is the primary SMS flow.
router.post('/shipments',      requirePermission('shipments'), validate(schemas.shipmentCreate), asyncWrap(shipmentController.create));
router.get('/shipments/:id',                asyncWrap(shipmentController.getOne));
router.put('/shipments/:id',   requirePermission('shipment_update_status', 'shipments'), validate(schemas.shipmentUpdate), asyncWrap(shipmentController.update));
router.delete('/shipments/:id', requirePermission('shipment_delete'), asyncWrap(shipmentController.remove));

// Shipping data — vendor uploads one packing Excel per consignment → carton × SKU
// detail + generated CI/packing-list documents (combined + per-PO).
router.post('/shipments/:id/shipping-data', requirePermission('shipment_import_export', 'shipments'), upload.single('file'), asyncWrap(packingController.uploadShippingData));
router.get('/shipments/:id/documents', asyncWrap(packingController.getDocuments));

// Item Receipt LINES sync from NetSuite (smsNetsuiteSync writes sms_item_receipts
// /_lines) and feed the PO detail's reconciliation (smsService.reconcilePo) — no
// line write endpoints. The only portal-owned write is the shipment↔IR MATCH
// (matched_shipment_id), reactivated 2026-07-22 to target landed-cost pushes.
router.get('/shipments/:id/receipt-matches', asyncWrap(receiptController.suggestForShipment));
// Receiving confirmation — staff only; a vendor must not confirm receipt of their
// own goods (`shipment_update_status`, which Vendor does not hold).
router.post('/receipts/manual-match', requirePermission('shipment_update_status'), validate(schemas.receiptManualMatch), asyncWrap(receiptController.manualMatch));
router.post('/receipts/:id/match',   requirePermission('shipment_update_status'), validate(schemas.receiptMatch), asyncWrap(receiptController.setMatch));
router.delete('/receipts/:id/match', requirePermission('shipment_update_status'), asyncWrap(receiptController.clearMatch));
// ...and its negative: reject a suggested (receipt × shipment) pair so the matcher
// stops offering it. Same permission — it is the same decision, answered "no".
router.post('/receipts/:id/reject',   requirePermission('shipment_update_status'), validate(schemas.receiptMatch), asyncWrap(receiptController.rejectMatch));
router.delete('/receipts/:id/reject', requirePermission('shipment_update_status'), asyncWrap(receiptController.unrejectMatch));

module.exports = router;
