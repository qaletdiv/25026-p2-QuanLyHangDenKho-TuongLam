const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const contactController = require('../controllers/contactController');

router.get('/', asyncWrap(contactController.getAll));

module.exports = router;
