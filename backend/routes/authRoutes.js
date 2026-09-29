const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const authController = require('../controllers/authController');

router.post('/', asyncWrap(authController.login));

module.exports = router;
