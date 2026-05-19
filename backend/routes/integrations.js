const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const integrationController = require('../controllers/integrationController');

router.get('/netsuite/pos', requireAdmin, asyncWrap(integrationController.getNetSuitePOs));

module.exports = router;
