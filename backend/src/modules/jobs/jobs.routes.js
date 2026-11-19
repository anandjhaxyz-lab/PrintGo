const express = require('express');
const router = express.Router();
const jobsController = require('./jobs.controller');
const { protect, restrictTo } = require('../../middlewares/auth');
const { requireSessionOrUser } = require('../../middlewares/session');
const { readOnlyGuard } = require('../../middlewares/readOnlyGuard');
const { validate } = require('../../middlewares/validate');
const { createJobSchema, updateJobStatusSchema, resolveAmbiguitySchema } = require('../../utils/schemas');

router.get('/', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), jobsController.getAllJobs);
router.get('/export/csv', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), jobsController.exportJobsCsv);
router.get('/:id', requireSessionOrUser, jobsController.getJob);
router.get('/:id/invoice', requireSessionOrUser, jobsController.getInvoice);
router.get('/:id/invoice/download', requireSessionOrUser, jobsController.downloadInvoicePdf);
router.post('/', requireSessionOrUser, validate(createJobSchema), jobsController.createJob);
router.put('/:id/status', protect, restrictTo('SUPERADMIN', 'FRANCHISEE', 'STAFF'), readOnlyGuard, validate(updateJobStatusSchema), jobsController.updateJobStatus);
router.post('/:id/resolve-ambiguity', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), readOnlyGuard, validate(resolveAmbiguitySchema), jobsController.resolveAmbiguity);

module.exports = router;
