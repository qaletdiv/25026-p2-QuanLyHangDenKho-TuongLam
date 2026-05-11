const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const historyController = require('../controllers/historyController');

router.get('/', asyncWrap(historyController.getHistoryBookings));

module.exports = router;
