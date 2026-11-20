const express = require('express');
const { protect, restrictTo } = require('../../middlewares/auth');
const { readOnlyGuard } = require('../../middlewares/readOnlyGuard');
const adminController = require('./admin.controller');

const router = express.Router();

// Apply auth middleware and read-only guard to all admin routes
router.use(protect);
router.use(readOnlyGuard);

// Global Stats & Discovery
router.get('/stats', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getStats);
router.get('/companies', restrictTo('SUPERADMIN'), adminController.getAllCompanies);
router.get('/machines', restrictTo('SUPERADMIN'), adminController.getAllMachines);

// ==============================================
// PHASE 5: ENTERPRISE ANALYTICS & MONITORING
// ==============================================
router.get('/analytics/overview', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getOverviewStats);
router.get('/analytics/sales-charts', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getSalesCharts);
router.get('/payments', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getPayments);
router.get('/invoices', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getInvoices);
router.get('/credit-notes', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getCreditNotes);
router.get('/customers', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getCustomers);
router.get('/operators', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getOperators);
router.get('/audit-logs', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getAuditLogs);
router.get('/reports/:type/export', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.exportReportCsv);

// ==============================================
// PRINT JOB DISPATCH & RECONCILIATION
// ==============================================
router.post('/jobs/:shortId/confirm-cash', restrictTo('SUPERADMIN', 'FRANCHISEE', 'STAFF'), adminController.confirmCashPayment);

router.post('/dispatch-job', restrictTo('SUPERADMIN'), async (req, res, next) => {
  try {
    const { shortId } = req.body || {};
    if (!shortId || typeof shortId !== 'string' || !shortId.trim()) {
      return res.status(400).json({ success: false, error: 'shortId is required' });
    }
    const cleanShortId = shortId.trim();

    // Historical guard: job ab36197e must NEVER be dispatched or retried
    if (cleanShortId === 'ab36197e') {
      return res.status(400).json({ success: false, error: 'Historical baseline job ab36197e is protected and cannot be retried or dispatched' });
    }

    const prisma = require('../../utils/prisma');
    const existingJob = await prisma.printJob.findUnique({
      where: { shortId: cleanShortId },
      include: { machine: true }
    });
    if (!existingJob) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const { MAX_PRINT_ATTEMPTS, startPrintingProcess } = require('../../services/queueService');
    const maxAttempts = MAX_PRINT_ATTEMPTS || 3;

    // UP-02: Check job-level maximum attempts
    const currentAttempts = existingJob.printAttempts || 0;
    if (currentAttempts >= maxAttempts) {
      return res.status(409).json({
        success: false,
        error: 'MAX_PRINT_ATTEMPTS_EXCEEDED',
        message: `Maximum ${maxAttempts} print attempts exceeded for job ${cleanShortId}. Current attempts: ${currentAttempts}, maximum: ${maxAttempts}.`,
        attempts: currentAttempts,
        maxAttempts
      });
    }

    // UP-02: Check transaction/payment-level maximum attempts across sibling jobs
    if (existingJob.paymentId) {
      const siblingJobs = await prisma.printJob.findMany({
        where: { paymentId: existingJob.paymentId },
        select: { id: true, printAttempts: true }
      });
      const totalTxAttempts = siblingJobs.reduce((sum, j) => sum + (j.printAttempts || 0), 0);
      if (totalTxAttempts >= maxAttempts) {
        return res.status(409).json({
          success: false,
          error: 'MAX_PRINT_ATTEMPTS_EXCEEDED',
          message: `Maximum ${maxAttempts} print attempts exceeded for payment transaction ${existingJob.paymentId}. Total attempts: ${totalTxAttempts}, maximum: ${maxAttempts}.`,
          attempts: totalTxAttempts,
          maxAttempts
        });
      }
    }

    // UP-03: Ambiguity Lockout - a job in PRINTING cannot be redispatched while unresolved
    if (existingJob.status === 'PRINTING') {
      return res.status(409).json({
        success: false,
        error: 'AMBIGUOUS_JOB_LOCKED',
        message: `Job ${cleanShortId} is currently in PRINTING (ambiguous physical outcome). Must be resolved by authorized operator before re-dispatch.`,
        status: existingJob.status
      });
    }

    // If job was in FAILED, allow authorized operator retry within attempt limit by restoring to WAITING
    let restoredFromFailed = false;
    if (existingJob.status === 'FAILED') {
      await prisma.printJob.update({
        where: { id: existingJob.id },
        data: { status: 'WAITING' }
      });
      restoredFromFailed = true;
    }

    const dispatchResult = await startPrintingProcess(cleanShortId, req.app.get('io'));

    if (dispatchResult && dispatchResult.success === false) {
      if (restoredFromFailed) {
        await prisma.printJob.update({
          where: { id: existingJob.id },
          data: { status: 'FAILED' }
        });
      }
      const statusCode = (dispatchResult.code === 'MAX_PRINT_ATTEMPTS_EXCEEDED' || dispatchResult.code === 'LEGACY_ATTEMPTS_EXHAUSTED') ? 409 : 400;
      return res.status(statusCode).json({
        success: false,
        error: dispatchResult.code,
        message: dispatchResult.message,
        attempts: dispatchResult.attempts,
        maxAttempts: dispatchResult.maxAttempts || maxAttempts
      });
    }

    const freshJob = await prisma.printJob.findUnique({
      where: { shortId: cleanShortId },
      select: { shortId: true, status: true, printAttempts: true }
    });

    const finalAttempts = freshJob?.printAttempts || (currentAttempts + 1);

    res.json({
      success: true,
      message: `Dispatched ${cleanShortId}`,
      job: freshJob,
      attempts: finalAttempts,
      maxAttempts
    });
  } catch (e) {
    next(e);
  }
});

router.post('/reconcile-job', restrictTo('SUPERADMIN', 'FRANCHISEE'), async (req, res, next) => {
  try {
    const {
      shortId,
      outcome,
      reason,
      evidence,
      physicalConfirmation,
      physicalVerificationConfirmed,
      spoolerEmptyOnly
    } = req.body || {};

    if (!shortId || typeof shortId !== 'string' || !shortId.trim()) {
      return res.status(400).json({ success: false, error: 'shortId is required' });
    }
    const cleanShortId = shortId.trim();

    // Historical guard: job ab36197e must NEVER be modified
    if (cleanShortId === 'ab36197e') {
      return res.status(400).json({ success: false, error: 'Historical baseline job ab36197e is protected and cannot be altered' });
    }

    // Require explicit outcome: must be 'COMPLETED' or 'FAILED'
    if (!outcome || !['COMPLETED', 'FAILED'].includes(outcome)) {
      return res.status(400).json({
        success: false,
        error: 'An explicit outcome of COMPLETED or FAILED is required to reconcile a job.'
      });
    }

    // Validate operator reason: minimum 10 non-whitespace characters, max 500
    const rawReason = reason || evidence;
    const operatorReason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (operatorReason.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'An operator reason of at least 10 non-whitespace characters is required.'
      });
    }
    if (operatorReason.length > 500) {
      return res.status(400).json({
        success: false,
        error: 'Operator reason cannot exceed 500 characters.'
      });
    }

    // Physical confirmation check for COMPLETED:
    if (outcome === 'COMPLETED') {
      if (spoolerEmptyOnly === true) {
        return res.status(400).json({
          success: false,
          error: 'Spooler-empty status alone is insufficient evidence. Authorized human physical verification confirming the customer document was printed is required to mark a job COMPLETED.'
        });
      }
      const hasPhysical = physicalConfirmation === true || physicalVerificationConfirmed === true;
      if (!hasPhysical) {
        return res.status(400).json({
          success: false,
          error: 'Explicit physical confirmation (physicalConfirmation: true) is required to mark a PRINTING job as COMPLETED.'
        });
      }
    }

    // Tenant-scoped lookup & multi-tenancy authorization BEFORE any early return
    const prisma = require('../../utils/prisma');
    const existingJob = await prisma.printJob.findUnique({
      where: { shortId: cleanShortId },
      include: { machine: { select: { id: true, companyId: true, name: true } } }
    });
    if (!existingJob) return res.status(404).json({ success: false, error: 'Job not found' });

    // Multi-tenancy check: FRANCHISEE can only access jobs belonging to their own company
    if (req.user.role !== 'SUPERADMIN') {
      if (!req.user.companyId || !existingJob.machine?.companyId || existingJob.machine.companyId !== req.user.companyId) {
        return res.status(403).json({
          success: false,
          error: 'Access denied: Job belongs to another company.'
        });
      }
    }

    // Explicitly construct safe sanitized response payload (never expose encryptedKey, iv, etc.)
    const sanitizeJobResponse = (job) => ({
      id: job.id,
      shortId: job.shortId,
      status: job.status,
      cost: job.cost,
      pagesToPrint: job.pagesToPrint,
      copies: job.copies,
      color: job.color,
      duplex: job.duplex,
      paperSize: job.paperSize,
      machineId: job.machineId,
      printerDeviceId: job.printerDeviceId || null,
      printerWindowsQueueName: job.printerWindowsQueueName || null,
      paymentMode: job.paymentMode,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    });

    // Idempotency: if already matching target status, return cleanly with safe sanitized payload
    if (existingJob.status === outcome) {
      return res.json({
        success: true,
        message: `Job ${cleanShortId} already has status ${outcome}`,
        job: sanitizeJobResponse(existingJob),
        reconciled: false
      });
    }

    const jobsService = require('../jobs/jobs.service');
    const updatedJob = await jobsService.resolveAmbiguousJob(cleanShortId, {
      outcome,
      reason: operatorReason,
      physicalConfirmation: outcome === 'COMPLETED',
      spoolerEmptyOnly: false,
      ipAddress: req.ip
    }, req.user);

    req.app.get('io')?.emit('job_status_changed', updatedJob);

    return res.json({
      success: true,
      message: `Job ${cleanShortId} reconciled to ${outcome}`,
      job: sanitizeJobResponse(updatedJob),
      reconciled: true
    });
  } catch (e) {
    next(e);
  }
});

// ==============================================
// PRICING & BUSINESS SETTINGS
// ==============================================
router.get('/pricing', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getPricingProfiles);
router.post('/pricing', restrictTo('SUPERADMIN'), adminController.savePricingProfile);
router.get('/business-profile', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getBusinessProfile);
router.put('/business-profile', restrictTo('SUPERADMIN'), adminController.saveBusinessProfile);

// ==============================================
// REFUNDS & FINANCIAL RECOVERY (Phase 4A & 4E)
// ==============================================
router.get('/refunds', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getRefunds);
router.get('/refunds/:id', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getRefundById);
router.post('/refunds', restrictTo('SUPERADMIN'), adminController.createRefund);

// ==============================================
// RECONCILIATION ENGINE (Phase 4D & 4E)
// ==============================================
router.get('/reconciliation', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getReconciliationRecords);
router.get('/reconciliation/:id', restrictTo('SUPERADMIN', 'FRANCHISEE'), adminController.getReconciliationById);
router.post('/reconciliation/run', restrictTo('SUPERADMIN'), adminController.runReconciliation);
router.post('/reconciliation/:id/resolve', restrictTo('SUPERADMIN'), adminController.resolveReconciliation);

// ==============================================
// PERMANENT PRINTER QR MANAGEMENT (Phase 2)
// ==============================================
const printerQrAdminController = require('./printerQr.admin.controller');
const printerDiscoveryAdminController = require('./printerDiscovery.admin.controller');

router.get('/printer-discoveries', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerDiscoveryAdminController.listPrinterDiscoveries);
router.get('/printer-devices', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerDiscoveryAdminController.listApprovedPrinterDevices);
router.post('/printer-discoveries/:id/approve', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerDiscoveryAdminController.approvePrinterDiscovery);
router.post('/printer-devices/:id/disable', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerDiscoveryAdminController.disablePrinterDevice);
router.post('/printer-devices/:id/enable', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerDiscoveryAdminController.enablePrinterDevice);
router.post('/printer-devices/:id/remap', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerDiscoveryAdminController.remapPrinterDevice);

router.get('/printer-qrs', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.listPrinterQrs);
router.get('/printer-qrs/:id', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.getPrinterQrById);
router.post('/printer-qrs', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.generatePrinterQr);
router.post('/printer-devices/:id/qr', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.generatePrinterDeviceQr);
router.post('/printer-qrs/:id/revoke', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.revokePrinterQr);
router.post('/printer-qrs/:id/replace', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.replacePrinterQr);
router.get('/machines/:id/qr', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.getMachineQrLedger);

module.exports = router;
