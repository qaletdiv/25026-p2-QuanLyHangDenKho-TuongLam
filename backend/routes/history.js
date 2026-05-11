const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const historyController = require('../controllers/historyController');

router.get('/',            asyncWrap(historyController.getHistory));
router.post('/sweep',      requireAuth, asyncWrap(historyController.sweep));

module.exports = router;
