const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const integrationController = require('../controllers/integrationController');

router.get('/netsuite/pos', asyncWrap(integrationController.getNetSuitePOs));

module.exports = router;
