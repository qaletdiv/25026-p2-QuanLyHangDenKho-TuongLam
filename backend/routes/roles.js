const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth  = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const validate     = require('../middleware/validate');
const roleSchemas  = require('../validators/role');
const roleController = require('../controllers/roleController');

// Any authenticated user can read roles (needed for permission lookups)
router.get('/',       requireAuth,                                    asyncWrap(roleController.getAll));
router.post('/',      requireAdmin, validate(roleSchemas.create),     asyncWrap(roleController.create));
router.put('/:id',    requireAdmin, validate(roleSchemas.update),     asyncWrap(roleController.update));
router.delete('/:id', requireAdmin,                                   asyncWrap(roleController.remove));

module.exports = router;
