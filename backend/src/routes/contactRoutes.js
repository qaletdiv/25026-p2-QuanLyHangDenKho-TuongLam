const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middlewares/errorHandler');
const requirePermission = require('../middlewares/requirePermission');
const contactController = require('../controllers/contactController');

// The contact directory is its own page (`contacts` key — Admin/Logistics only)
// and nothing else fetches it, so the nav key is the right gate.
router.get('/', requirePermission('contacts'), asyncWrap(contactController.getAll));

module.exports = router;
