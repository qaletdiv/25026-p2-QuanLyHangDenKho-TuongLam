const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middlewares/errorHandler');
const requireAdmin = require('../middlewares/requireAdmin');
const validate = require('../middlewares/validate');
const userSchemas = require('../validators/userValidator');
const userController = require('../controllers/userController');

router.get('/',      requireAdmin,                                    asyncWrap(userController.getAll));
router.post('/',     requireAdmin, validate(userSchemas.create),      asyncWrap(userController.create));
router.put('/:id',   requireAdmin, validate(userSchemas.update),      asyncWrap(userController.update));
router.delete('/:id', requireAdmin,                                   asyncWrap(userController.remove));

module.exports = router;
