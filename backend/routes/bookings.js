const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const bookingSchemas = require('../validators/booking');
const asnSchemas = require('../validators/asn');
const bookingController = require('../controllers/bookingController');
const asnController = require('../controllers/asnController');

router.get('/',                                                                              asyncWrap(bookingController.getAll));
// lookup by booking_number — must be before /:id routes so "lookup" is not treated as an id
router.get('/lookup',                                                                        asyncWrap(bookingController.lookupByNumber));
router.get('/:id',                                                                           asyncWrap(bookingController.getOne));
router.post('/',                         requireAuth, validate(bookingSchemas.create),       asyncWrap(bookingController.create));
router.put('/:id',                       requireAuth, validate(bookingSchemas.update),       asyncWrap(bookingController.update));
router.delete('/:id',                    requireAuth,                                        asyncWrap(bookingController.remove));
router.post('/:id/commercial-invoice/confirm', requireAuth,                                  asyncWrap(bookingController.confirmCI));
router.get('/:id/commercial-invoice',                                                        asyncWrap(bookingController.getCI));

// ASN (Advanced Shipment Notice / Packing List) routes
router.get('/:id/asn',  requireAuth,                              asyncWrap(asnController.getAsn));
router.post('/:id/asn', requireAuth, validate(asnSchemas.generate), asyncWrap(asnController.generateAsn));

module.exports = router;
