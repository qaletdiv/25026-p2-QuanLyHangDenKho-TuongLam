const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const shipmentController = require('../controllers/shipmentController');

router.get('/',                         asyncWrap(shipmentController.getAll));
router.post('/bulk-status', requireAuth, asyncWrap(shipmentController.bulkStatus));
router.post('/',            requireAuth, asyncWrap(shipmentController.create));
router.get('/:id/line-items',            asyncWrap(shipmentController.getLineItems));
router.put('/:id',          requireAuth, asyncWrap(shipmentController.update));
router.delete('/:id',       requireAuth, asyncWrap(shipmentController.remove));

module.exports = router;
