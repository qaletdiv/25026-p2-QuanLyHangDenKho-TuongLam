const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const shipmentSchemas = require('../validators/shipment');
const shipmentController = require('../controllers/shipmentController');

router.get('/',                                                                              asyncWrap(shipmentController.getAll));
router.post('/bulk-status', requireAuth, validate(shipmentSchemas.bulkStatus),               asyncWrap(shipmentController.bulkStatus));
router.post('/',            requireAuth, validate(shipmentSchemas.create),                   asyncWrap(shipmentController.create));
router.get('/:id/line-items',                                                                asyncWrap(shipmentController.getLineItems));
router.put('/:id',          requireAuth, validate(shipmentSchemas.update),                   asyncWrap(shipmentController.update));
router.delete('/:id',       requireAuth,                                                     asyncWrap(shipmentController.remove));

module.exports = router;
