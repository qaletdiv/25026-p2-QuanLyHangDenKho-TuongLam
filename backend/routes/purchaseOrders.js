const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const poSchemas = require('../validators/purchaseOrder');
const poController = require('../controllers/purchaseOrderController');

router.get('/',                                                                              asyncWrap(poController.getAll));
router.post('/bulk',            requireAuth,                                                 asyncWrap(poController.bulkCreate));
router.post('/',                requireAuth,   validate(poSchemas.create),                   asyncWrap(poController.create));
router.get('/:id',                                                                           asyncWrap(poController.getOne));
router.put('/:id',              requireAuth,   validate(poSchemas.update),                   asyncWrap(poController.update));
router.delete('/:id',           requireAuth,                                                 asyncWrap(poController.remove));
router.get('/:id/shipment-lots',                                                             asyncWrap(poController.getShipmentLots));
router.post('/:id/line-items',  requireAuth,   validate(poSchemas.replaceLineItems),         asyncWrap(poController.replaceLineItems));
router.put('/:id/line-items/:sku', requireAuth, validate(poSchemas.updateLineItem),          asyncWrap(poController.updateLineItem));
router.get('/:id/fulfillment',                                                               asyncWrap(poController.getFulfillment));

module.exports = router;
