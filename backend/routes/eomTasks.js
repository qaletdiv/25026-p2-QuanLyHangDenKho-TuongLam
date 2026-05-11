const express = require('express');
const router = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const eomTaskController = require('../controllers/eomTaskController');

router.get('/',           asyncWrap(eomTaskController.getAll));
router.post('/bulk',      requireAuth, asyncWrap(eomTaskController.bulkCreate));
router.put('/:id',        requireAuth, asyncWrap(eomTaskController.update));

module.exports = router;
