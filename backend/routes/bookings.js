const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const bookingSchemas = require('../validators/booking');
const bookingController = require('../controllers/bookingController');

router.get('/',                                                                              asyncWrap(bookingController.getAll));
router.post('/',                         requireAuth, validate(bookingSchemas.create),       asyncWrap(bookingController.create));
router.put('/:id',                       requireAuth, validate(bookingSchemas.update),       asyncWrap(bookingController.update));
router.delete('/:id',                    requireAuth,                                        asyncWrap(bookingController.remove));
router.post('/:id/commercial-invoice/confirm', requireAuth,                                  asyncWrap(bookingController.confirmCI));
router.get('/:id/commercial-invoice',                                                        asyncWrap(bookingController.getCI));

module.exports = router;
