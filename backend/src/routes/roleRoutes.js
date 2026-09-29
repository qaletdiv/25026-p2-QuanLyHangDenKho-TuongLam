const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middlewares/errorHandler');
const requireAdmin = require('../middlewares/requireAdmin');
const requirePermission = require('../middlewares/requirePermission');
const validate     = require('../middlewares/validate');
const roleSchemas  = require('../validators/roleValidator');
const roleController = require('../controllers/roleController');

// Was "any authenticated user can read roles (needed for permission lookups)" —
// stale: a session's permissions are injected at login, and the server resolves
// role→permissions from roles.json directly (middleware/requirePermission), never
// over HTTP. The only consumers are the admin-only Roles and Users settings
// screens, so the role/permission matrix no longer leaks to every logged-in user.
router.get('/',       requirePermission('user_manage'),               asyncWrap(roleController.getAll));
router.post('/',      requireAdmin, validate(roleSchemas.create),     asyncWrap(roleController.create));
router.put('/:id',    requireAdmin, validate(roleSchemas.update),     asyncWrap(roleController.update));
router.delete('/:id', requireAdmin,                                   asyncWrap(roleController.remove));

module.exports = router;
