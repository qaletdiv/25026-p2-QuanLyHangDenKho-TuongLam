const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const controller = require('../modules/notifications/notificationController');

// All notification reads/writes are per-user (role + vendor scope), so auth is required.
router.get('/', requireAuth, asyncWrap(controller.list));
router.post('/seen', requireAuth, asyncWrap(controller.markSeen));

module.exports = router;
