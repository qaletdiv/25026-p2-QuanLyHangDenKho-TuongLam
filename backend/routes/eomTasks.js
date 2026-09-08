const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requirePermission = require('../middleware/requirePermission');
const validate = require('../middleware/validate');
const eomTaskSchemas = require('../validators/eomTask');
const eomTaskController = require('../controllers/eomTaskController');

// This router is still mounted but its page and data were removed long ago (see
// CLAUDE.md "Known debt"). Gating it on `eom` costs nothing and keeps a dormant
// write surface from being the weakest door in.
router.get('/',           requirePermission('eom'), asyncWrap(eomTaskController.getAll));
router.post('/bulk',      requirePermission('eom'), validate(eomTaskSchemas.bulkCreate), asyncWrap(eomTaskController.bulkCreate));
router.put('/:id',        requirePermission('eom'), validate(eomTaskSchemas.update),     asyncWrap(eomTaskController.update));

module.exports = router;
