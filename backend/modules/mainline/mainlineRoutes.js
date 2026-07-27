'use strict';

// Mainline module routes. Phase 2b mounts the WIP leg import; later phases add
// bookings / shipments / ci / fulfillment / asn under the same /mainline prefix.
const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../../middleware/errorHandler');
const upload = require('../../middleware/upload');
const requireAuth = require('../../middleware/auth');
const requireAdmin = require('../../middleware/requireAdmin');
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

// Legs (WIP) — Admin only; multipart field "file"
router.post('/wip-import', requireAdmin, upload.single('file'), asyncWrap(wipImportController.importWip));

// Bookings
router.get('/bookings',                          asyncWrap(bookingController.getAll));
router.post('/bookings',     requireAuth, validate(bookingSchemas.create), asyncWrap(bookingController.create));
router.get('/bookings/:id',                      asyncWrap(bookingController.getOne));
router.put('/bookings/:id',  requireAuth, validate(bookingSchemas.update), asyncWrap(bookingController.update));
router.post('/bookings/:id/approve', requireAuth, asyncWrap(bookingController.approve));
router.delete('/bookings/:id', requireAuth,      asyncWrap(bookingController.remove));

// Single-source upload: shipment-data Excel → CI + packing slip (Admin/coordinator)
router.post('/bookings/:id/shipment-data', requireAuth, upload.single('file'), asyncWrap(shipmentDataController.uploadShipmentData));
router.get('/bookings/:id/documents',            asyncWrap(shipmentDataController.getDocuments));

// Commercial invoices (per booking). Line items are derived from packing cartons;
// the CI is populated by the shipment-data upload above, so there is no manual
// upsert route — GET (view) + confirm only.
router.get('/bookings/:id/ci',                   asyncWrap(ciController.getCi));
router.post('/bookings/:id/ci/confirm', requireAuth, asyncWrap(ciController.confirmCi));

// Packing list (summary is a view)
router.get('/bookings/:id/packing',              asyncWrap(packingController.getPacking));

// ASN (per booking)
// ASN is shipment-scoped (arrival notice for a physical shipment)
router.post('/shipments/:id/asn', requireAuth,   asyncWrap(asnController.generateAsn));
router.get('/shipments/:id/asn',                 asyncWrap(asnController.getAsn));

// Fulfillment (three-way match). Component-PO reconcile registered BEFORE /:trn
// so "/fulfillment/po/<poNumber>" isn't captured as a TRN.
router.get('/fulfillment/po/:poNumber',          asyncWrap(fulfillmentController.getPoReconcile));
router.get('/fulfillment/:trn',                  asyncWrap(fulfillmentController.getFulfillment));

// Item Receipt landed-cost match (manual-match before /:id/match so it isn't captured)
router.post('/receipts/manual-match',   requireAuth, asyncWrap(receiptController.manualMatch));
router.post('/receipts/:id/match',       requireAuth, asyncWrap(receiptController.setMatch));
router.delete('/receipts/:id/match',     requireAuth, asyncWrap(receiptController.clearMatch));

// Shipments
router.get('/shipments',                         asyncWrap(shipmentController.getAll));
router.put('/shipments/bulk-status', requireAuth, validate(shipmentSchemas.bulkStatus), asyncWrap(shipmentController.bulkStatus));
router.get('/shipments/:id',                     asyncWrap(shipmentController.getOne));
router.put('/shipments/:id', requireAuth, validate(shipmentSchemas.update), asyncWrap(shipmentController.update));
router.delete('/shipments/:id', requireAuth,     asyncWrap(shipmentController.remove));

module.exports = router;
