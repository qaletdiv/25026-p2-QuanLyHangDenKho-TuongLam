const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const { masterDataArray } = require('../validators/masterData');
const masterDataController = require('../controllers/masterDataController');

router.get('/suppliers',    asyncWrap(masterDataController.getSuppliers));
router.put('/suppliers',    requireAuth, validate(masterDataArray), asyncWrap(masterDataController.putSuppliers));

router.get('/couriers',     asyncWrap(masterDataController.getCouriers));
router.put('/couriers',     requireAuth, validate(masterDataArray), asyncWrap(masterDataController.putCouriers));

router.get('/incoterms',    asyncWrap(masterDataController.getIncoterms));
router.put('/incoterms',    requireAuth, validate(masterDataArray), asyncWrap(masterDataController.putIncoterms));

router.get('/statuses',     asyncWrap(masterDataController.getStatuses));
router.put('/statuses',     requireAuth, validate(masterDataArray), asyncWrap(masterDataController.putStatuses));

router.get('/warehouses',   asyncWrap(masterDataController.getWarehouses));
router.put('/warehouses',   requireAuth, validate(masterDataArray), asyncWrap(masterDataController.putWarehouses));

router.get('/modes',        asyncWrap(masterDataController.getModes));
router.put('/modes',        requireAuth, validate(masterDataArray), asyncWrap(masterDataController.putModes));

module.exports = router;
