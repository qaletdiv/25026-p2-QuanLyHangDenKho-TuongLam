const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const poController = require('../controllers/purchaseOrderController');

router.get('/',                                asyncWrap(poController.getAll));
router.post('/bulk',            requireAuth,   asyncWrap(poController.bulkCreate));
router.post('/',                requireAuth,   asyncWrap(poController.create));
router.get('/:id',                             asyncWrap(poController.getOne));
router.put('/:id',              requireAuth,   asyncWrap(poController.update));
router.delete('/:id',           requireAuth,   asyncWrap(poController.remove));
router.get('/:id/shipment-lots',               asyncWrap(poController.getShipmentLots));
router.post('/:id/line-items',  requireAuth,   asyncWrap(poController.replaceLineItems));
router.put('/:id/line-items/:sku', requireAuth, asyncWrap(poController.updateLineItem));
router.get('/:id/fulfillment',                 asyncWrap(poController.getFulfillment));

module.exports = router;
