const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requirePermission = require('../middleware/requirePermission');
const validate = require('../middleware/validate');
const { masterDataArray, productionScheduleArray, seasonCreate } = require('../validators/masterData');
const masterDataController = require('../controllers/masterDataController');

// Authorization: WRITES require `settings_edit` (these are the Settings pages —
// previously any valid token of any role could overwrite the supplier, status or
// warehouse master lists). GETs stay open behind the global auth gate on purpose:
// nearly every page in the app reads these for its dropdowns, and gating them on
// a nav key would break pages for roles that legitimately need the labels but not
// the settings screens.

router.get('/suppliers',    asyncWrap(masterDataController.getSuppliers));
router.put('/suppliers',    requirePermission('settings_edit'), validate(masterDataArray), asyncWrap(masterDataController.putSuppliers));

router.get('/couriers',     asyncWrap(masterDataController.getCouriers));
router.put('/couriers',     requirePermission('settings_edit'), validate(masterDataArray), asyncWrap(masterDataController.putCouriers));

router.get('/incoterms',    asyncWrap(masterDataController.getIncoterms));
router.put('/incoterms',    requirePermission('settings_edit'), validate(masterDataArray), asyncWrap(masterDataController.putIncoterms));

router.get('/statuses',     asyncWrap(masterDataController.getStatuses));
router.put('/statuses',     requirePermission('settings_edit'), validate(masterDataArray), asyncWrap(masterDataController.putStatuses));

router.get('/warehouses',   asyncWrap(masterDataController.getWarehouses));
router.put('/warehouses',   requirePermission('settings_edit'), validate(masterDataArray), asyncWrap(masterDataController.putWarehouses));

router.get('/modes',        asyncWrap(masterDataController.getModes));
router.put('/modes',        requirePermission('settings_edit'), validate(masterDataArray), asyncWrap(masterDataController.putModes));

// Normalized destination master data (read-only; owned by migration/ingestion)
router.get('/warehouse-facilities', asyncWrap(masterDataController.getWarehouseFacilities));
router.get('/allocation-channels',  asyncWrap(masterDataController.getAllocationChannels));
router.get('/ports',                asyncWrap(masterDataController.getPorts));
router.get('/container-types',      asyncWrap(masterDataController.getContainerTypes));
router.get('/production-schedules', asyncWrap(masterDataController.getProductionSchedules));
// Editable per-season KPI gates (On Time / At Risk cutoffs) — set each season
router.put('/production-schedules', requirePermission('settings_edit'), validate(productionScheduleArray), asyncWrap(masterDataController.putProductionSchedules));
// Pre-load a new season (row in `seasons`; sync matches it by code later)
router.post('/seasons', requirePermission('settings_edit'), validate(seasonCreate), asyncWrap(masterDataController.postSeason));

module.exports = router;
