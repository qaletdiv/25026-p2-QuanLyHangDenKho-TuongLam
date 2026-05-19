const express    = require('express');
const router     = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requireAuth = require('../middleware/auth');
const upload     = require('../middleware/upload');
const ctrl       = require('../controllers/freightController');

router.get('/template',     requireAuth, ctrl.downloadTemplate);           // must be before /:id
router.post('/parse',       requireAuth, upload.single('file'), asyncWrap(ctrl.parse));
router.get('/',             requireAuth, asyncWrap(ctrl.getAll));
router.get('/:id',          requireAuth, asyncWrap(ctrl.getOne));
router.get('/:id/export',   requireAuth, asyncWrap(ctrl.exportXlsx));
router.delete('/:id',       requireAuth, asyncWrap(ctrl.remove));

module.exports = router;
