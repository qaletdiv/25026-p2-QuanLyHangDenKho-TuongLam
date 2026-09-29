const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const meController = require('../controllers/meController');

// Auth-only, by design: it answers only about the caller (identity comes from the
// verified JWT). Must stay mounted BELOW the auth gate in server.js.
router.get('/', asyncWrap(meController.me));

module.exports = router;
