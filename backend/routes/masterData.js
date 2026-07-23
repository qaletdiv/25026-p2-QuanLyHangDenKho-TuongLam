const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const { masterDataArray, productionScheduleArray, seasonCreate } = require('../validators/masterData');
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

// Normalized destination master data (read-only; owned by migration/ingestion)
router.get('/warehouse-facilities', asyncWrap(masterDataController.getWarehouseFacilities));
router.get('/allocation-channels',  asyncWrap(masterDataController.getAllocationChannels));
router.get('/ports',                asyncWrap(masterDataController.getPorts));
router.get('/container-types',      asyncWrap(masterDataController.getContainerTypes));
router.get('/production-schedules', asyncWrap(masterDataController.getProductionSchedules));
// Editable per-season KPI gates (On Time / At Risk cutoffs) — set each season
router.put('/production-schedules', requireAuth, validate(productionScheduleArray), asyncWrap(masterDataController.putProductionSchedules));
// Pre-load a new season (row in `seasons`; sync matches it by code later)
router.post('/seasons', requireAuth, validate(seasonCreate), asyncWrap(masterDataController.postSeason));

module.exports = router;
