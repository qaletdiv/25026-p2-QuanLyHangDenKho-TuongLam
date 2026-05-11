const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const masterDataController = require('../controllers/masterDataController');

router.get('/suppliers',    asyncWrap(masterDataController.getSuppliers));
router.put('/suppliers',    requireAuth, asyncWrap(masterDataController.putSuppliers));

router.get('/couriers',     asyncWrap(masterDataController.getCouriers));
router.put('/couriers',     requireAuth, asyncWrap(masterDataController.putCouriers));

router.get('/incoterms',    asyncWrap(masterDataController.getIncoterms));
router.put('/incoterms',    requireAuth, asyncWrap(masterDataController.putIncoterms));

router.get('/statuses',     asyncWrap(masterDataController.getStatuses));
router.put('/statuses',     requireAuth, asyncWrap(masterDataController.putStatuses));

module.exports = router;
