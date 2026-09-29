const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middlewares/errorHandler');
const requirePermission = require('../middlewares/requirePermission');
// Mainline forecast now runs on LIVE migrated data (was the frozen
// purchase-orders.json consumer in controllers/reportController). Same endpoint,
// same output contract → the Forecast UI is unchanged. SMS forecast is separate
// at /reports/sms/forecast.
const mainlineForecastController = require('../controllers/mainlineForecastController');

router.get('/', requirePermission('forecast'), asyncWrap(mainlineForecastController.getMainlineForecast));

module.exports = router;
