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
    const { shortId } = req.body;
    // Historical guard: job ab36197e must NEVER be dispatched or retried
    if (shortId === 'ab36197e') {
      return res.status(400).json({ success: false, error: 'Historical baseline job ab36197e is protected and cannot be retried or dispatched' });
    }
    const { startPrintingProcess } = require('../../services/queueService');
    await startPrintingProcess(shortId, req.app.get('io'));
    res.json({ success: true, message: `Dispatched ${shortId}` });
  } catch (e) {
    next(e);
  }
});

router.post('/reconcile-job', restrictTo('SUPERADMIN'), async (req, res, next) => {
  try {
    const { shortId, outcome = 'COMPLETED', evidence = 'Physical verification confirmed' } = req.body;
    if (!shortId) return res.status(400).json({ success: false, error: 'shortId is required' });

    // Historical guard: job ab36197e must NEVER be modified
    if (shortId === 'ab36197e') {
      return res.status(400).json({ success: false, error: 'Historical baseline job ab36197e is protected and cannot be altered' });
    }

    const prisma = require('../../utils/prisma');
    const job = await prisma.printJob.findUnique({
      where: { shortId },
      include: { document: true, machine: true }
    });

    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    // Idempotency: if already matching target status, return cleanly
    if (job.status === outcome) {
      return res.json({ 
        success: true, 
        message: `Job ${shortId} already has status ${outcome}`, 
        job,
        reconciled: false 
      });
    }

    const updatedJob = await prisma.printJob.update({
      where: { shortId },
      data: { status: outcome },
      include: { document: true }
    });

    // Record audit trail in PrintHistory
    const history = await prisma.printHistory.create({
      data: {
        printJobId: job.id,
        success: outcome === 'COMPLETED',
        errorDetails: `Operator reconciliation: ${evidence}`,
        completedAt: new Date()
      }
    });

    req.app.get('io')?.emit('job_status_changed', updatedJob);

    res.json({
      success: true,
      message: `Job ${shortId} reconciled to ${outcome}`,
      job: updatedJob,
      historyId: history.id,
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

router.get('/printer-qrs', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.listPrinterQrs);
router.get('/printer-qrs/:id', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.getPrinterQrById);
router.post('/printer-qrs', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.generatePrinterQr);
router.post('/printer-devices/:id/qr', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.generatePrinterDeviceQr);
router.post('/printer-qrs/:id/revoke', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.revokePrinterQr);
router.post('/printer-qrs/:id/replace', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.replacePrinterQr);
router.get('/machines/:id/qr', restrictTo('SUPERADMIN', 'FRANCHISEE'), printerQrAdminController.getMachineQrLedger);

module.exports = router;
