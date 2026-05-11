const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const bookingController = require('../controllers/bookingController');

router.get('/',                                           asyncWrap(bookingController.getAll));
router.post('/',                         requireAuth,     asyncWrap(bookingController.create));
router.put('/:id',                       requireAuth,     asyncWrap(bookingController.update));
router.delete('/:id',                    requireAuth,     asyncWrap(bookingController.remove));
router.post('/:id/commercial-invoice/confirm', requireAuth, asyncWrap(bookingController.confirmCI));
router.get('/:id/commercial-invoice',         asyncWrap(bookingController.getCI));

module.exports = router;
