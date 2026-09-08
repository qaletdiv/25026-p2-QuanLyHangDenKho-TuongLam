'use strict';

// Mainline module routes. Phase 2b mounts the WIP leg import; later phases add
// bookings / shipments / ci / fulfillment / asn under the same /mainline prefix.
const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../../middleware/errorHandler');
const upload = require('../../middleware/upload');
const requireAdmin = require('../../middleware/requireAdmin');
const requirePermission = require('../../middleware/requirePermission');
const validate = require('../../middleware/validate');
const wipImportController = require('./legs/wipImportController');
const bookingController = require('./bookings/mainlineBookingController');
const bookingSchemas = require('./bookings/mainlineBookingValidator');
const shipmentController = require('./shipments/mainlineShipmentController');
const shipmentSchemas = require('./shipments/mainlineShipmentValidator');
const ciController = require('./ci/mainlineCiController');
const shipmentDataController = require('./ci/shipmentDataController');
const packingController = require('./packing/mainlinePackingController');
const fulfillmentController = require('./fulfillment/fulfillmentController');
const asnController = require('./asn/mainlineAsnController');
const receiptController = require('./receipts/mainlineReceiptController');

// ---------------------------------------------------------------------------
// Authorization. Reads sit behind the global auth gate (server.js) and are
// row-scoped per caller in the controllers; WRITES additionally require an
// ACTION permission key from roles.json. Several writes list more than one key
// because more than one capability legitimately reaches them — e.g. a Vendor
// attaches shipment data to their own booking via `booking_create_mainline`,
// while Logistics/the forwarder does it via `shipment_import_export`. Granting
// on ANY key avoids stripping capability from a role that holds a different one.
// ---------------------------------------------------------------------------

// Legs (WIP) — Admin only; multipart field "file"
router.post('/wip-import', requireAdmin, upload.single('file'), asyncWrap(wipImportController.importWip));

// Bookings
router.get('/bookings',                          asyncWrap(bookingController.getAll));
router.post('/bookings',     requirePermission('booking_create_mainline'), validate(bookingSchemas.create), asyncWrap(bookingController.create));
router.get('/bookings/:id',                      asyncWrap(bookingController.getOne));
router.put('/bookings/:id',  requirePermission('booking_create_mainline'), validate(bookingSchemas.update), asyncWrap(bookingController.update));
router.post('/bookings/:id/approve', requirePermission('booking_approve'), asyncWrap(bookingController.approve));
router.delete('/bookings/:id', requirePermission('booking_delete'),      asyncWrap(bookingController.remove));

// Single-source upload: shipment-data Excel → CI + packing slip (Admin/coordinator)
router.post('/bookings/:id/shipment-data', requirePermission('shipment_import_export', 'booking_create_mainline'), upload.single('file'), asyncWrap(shipmentDataController.uploadShipmentData));
router.get('/bookings/:id/documents',            asyncWrap(shipmentDataController.getDocuments));

// Commercial invoices (per booking). Line items are derived from packing cartons;
// the CI is populated by the shipment-data upload above, so there is no manual
// upsert route — GET (view) + confirm only.
router.get('/bookings/:id/ci',                   asyncWrap(ciController.getCi));
router.post('/bookings/:id/ci/confirm', requirePermission('shipment_import_export', 'booking_create_mainline'), asyncWrap(ciController.confirmCi));

// Packing list (summary is a view)
router.get('/bookings/:id/packing',              asyncWrap(packingController.getPacking));

// ASN (per booking)
// ASN is shipment-scoped (arrival notice for a physical shipment)
router.post('/shipments/:id/asn', requirePermission('shipment_import_export'),   asyncWrap(asnController.generateAsn));
router.get('/shipments/:id/asn',                 asyncWrap(asnController.getAsn));

// Fulfillment (three-way match). Component-PO reconcile registered BEFORE /:trn
// so "/fulfillment/po/<poNumber>" isn't captured as a TRN.
router.get('/fulfillment/po/:poNumber',          asyncWrap(fulfillmentController.getPoReconcile));
router.get('/fulfillment/leg/:legId',            asyncWrap(fulfillmentController.getLegReconcile));
router.get('/fulfillment/:trn',                  asyncWrap(fulfillmentController.getFulfillment));

// Item Receipt landed-cost match (manual-match before /:id/match so it isn't captured)
// Receiving/reconciliation is a logistics function — `shipment_update_status` is
// the closest existing key (no `receipt_match` key exists). Vendors lack it, which
// is correct: a vendor must not confirm receipt of their own goods.
router.post('/receipts/manual-match',   requirePermission('shipment_update_status'), asyncWrap(receiptController.manualMatch));
router.post('/receipts/:id/match',       requirePermission('shipment_update_status'), asyncWrap(receiptController.setMatch));
router.delete('/receipts/:id/match',     requirePermission('shipment_update_status'), asyncWrap(receiptController.clearMatch));
// ...and its negative: reject a suggested (receipt × shipment) pair so the matcher
// stops offering it. Same permission — it is the same decision, answered "no".
router.post('/receipts/:id/reject',      requirePermission('shipment_update_status'), asyncWrap(receiptController.rejectMatch));
router.delete('/receipts/:id/reject',    requirePermission('shipment_update_status'), asyncWrap(receiptController.unrejectMatch));

// PO leg → its consignments (read; the Shipments section on the PO leg detail).
// Auth-only like every other transactional mainline read — the handler row-scopes
// via assertLegVisible. Registered here, not in modules/po, because shipments are
// this module's tables; the leg page fetches it alongside the leg + reconcile.
router.get('/legs/:legId/shipments',             asyncWrap(shipmentController.getByLeg));

// Shipments
router.get('/shipments',                         asyncWrap(shipmentController.getAll));
router.put('/shipments/bulk-status', requirePermission('shipment_update_status'), validate(shipmentSchemas.bulkStatus), asyncWrap(shipmentController.bulkStatus));
router.get('/shipments/:id',                     asyncWrap(shipmentController.getOne));
router.put('/shipments/:id', requirePermission('shipment_update_status'), validate(shipmentSchemas.update), asyncWrap(shipmentController.update));
router.delete('/shipments/:id', requirePermission('shipment_delete'),     asyncWrap(shipmentController.remove));

module.exports = router;
