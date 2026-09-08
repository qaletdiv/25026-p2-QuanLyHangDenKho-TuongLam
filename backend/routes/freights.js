const express    = require('express');
const router     = express.Router();
const { asyncWrap } = require('../middleware/errorHandler');
const requirePermission = require('../middleware/requirePermission');
const upload     = require('../middleware/upload');
const ctrl       = require('../controllers/freightController');

// Negotiated carrier rates — commercially sensitive and their own page, so the
// whole router takes `freight` (Admin + Logistics). Only /freights pages fetch it.
const requireFreight = requirePermission('freight');

router.get('/template',     requireFreight, ctrl.downloadTemplate);           // must be before /:id
router.post('/parse',       requireFreight, upload.single('file'), asyncWrap(ctrl.parse));
router.get('/',             requireFreight, asyncWrap(ctrl.getAll));
router.get('/:id',          requireFreight, asyncWrap(ctrl.getOne));
router.get('/:id/export',   requireFreight, asyncWrap(ctrl.exportXlsx));
router.delete('/:id',       requireFreight, asyncWrap(ctrl.remove));

module.exports = router;
