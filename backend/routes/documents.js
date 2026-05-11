const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const upload = require('../middleware/upload');
const documentController = require('../controllers/documentController');

router.post('/upload', upload.single('file'), asyncWrap(documentController.upload));

module.exports = router;
