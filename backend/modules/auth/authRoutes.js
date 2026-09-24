const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../../middleware/errorHandler');
const authController = require('./authController');

router.post('/', asyncWrap(authController.login));

module.exports = router;
