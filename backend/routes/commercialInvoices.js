const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const upload = require('../middleware/upload');
const commercialInvoiceController = require('../controllers/commercialInvoiceController');

router.post('/parse', upload.single('file'), asyncWrap(commercialInvoiceController.parse));

module.exports = router;
