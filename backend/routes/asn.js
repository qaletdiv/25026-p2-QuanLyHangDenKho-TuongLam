/**
 * ASN route definitions — kept here for reference.
 * These routes are registered directly in routes/bookings.js (not mounted separately
 * in server.js) because they are nested under /bookings/:id.
 *
 * Effective routes:
 *   GET  /bookings/:id/asn  — get latest ASN for a booking
 *   POST /bookings/:id/asn  — generate (or regenerate) packing list
 */
const express = require('express');
const router = express.Router({ mergeParams: true });
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const asnSchemas = require('../validators/asn');
const asnController = require('../controllers/asnController');

// GET  /bookings/:id/asn
router.get('/',  requireAuth, asyncWrap(asnController.getAsn));

// POST /bookings/:id/asn
router.post('/', requireAuth, validate(asnSchemas.generate), asyncWrap(asnController.generateAsn));

module.exports = router;
