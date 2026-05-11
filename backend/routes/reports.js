const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const reportController = require('../controllers/reportController');

router.get('/', asyncWrap(reportController.getReports));

module.exports = router;
