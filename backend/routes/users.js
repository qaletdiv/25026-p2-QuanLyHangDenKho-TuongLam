const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdmin');
const validate = require('../middleware/validate');
const userSchemas = require('../validators/user');
const userController = require('../controllers/userController');

router.get('/',      requireAdmin,                                    asyncWrap(userController.getAll));
router.post('/',     requireAdmin, validate(userSchemas.create),      asyncWrap(userController.create));
router.put('/:id',   requireAdmin, validate(userSchemas.update),      asyncWrap(userController.update));
router.delete('/:id', requireAdmin,                                   asyncWrap(userController.remove));

module.exports = router;
