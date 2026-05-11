const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const eomTaskSchemas = require('../validators/eomTask');
const eomTaskController = require('../controllers/eomTaskController');

router.get('/',           asyncWrap(eomTaskController.getAll));
router.post('/bulk',      requireAuth, validate(eomTaskSchemas.bulkCreate), asyncWrap(eomTaskController.bulkCreate));
router.put('/:id',        requireAuth, validate(eomTaskSchemas.update),     asyncWrap(eomTaskController.update));

module.exports = router;
