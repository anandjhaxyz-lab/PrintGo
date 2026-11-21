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
    const { shortId, reason } = req.body || {};
    if (!shortId || typeof shortId !== 'string' || !shortId.trim()) {
      return res.status(400).json({ success: false, error: 'shortId is required' });
    }
    const cleanShortId = shortId.trim();

    // Historical guard: job ab36197e must NEVER be dispatched or retried
    if (cleanShortId === 'ab36197e') {
      return res.status(400).json({ success: false, error: 'Historical baseline job ab36197e is protected and cannot be retried or dispatched' });
    }

    const prisma = require('../../utils/prisma');
    const { validateOperatorReason } = require('../../utils/stateMachine');
    const existingJob = await prisma.printJob.findUnique({
      where: { shortId: cleanShortId },
      include: { machine: true, payment: true }
    });
    if (!existingJob) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const { MAX_PRINT_ATTEMPTS, startPrintingProcess } = require('../../services/queueService');
    const maxAttempts = MAX_PRINT_ATTEMPTS || 3;

    // UP-03: Ambiguity Lockout - a job in PRINTING cannot be redispatched while unresolved
    if (existingJob.status === 'PRINTING') {
      return res.status(409).json({
        success: false,
        error: 'AMBIGUOUS_JOB_LOCKED',
        message: `Job ${cleanShortId} is currently in PRINTING (ambiguous physical outcome). Must be resolved by authorized operator before re-dispatch.`,
        status: existingJob.status
      });
    }

    // UP-02: Legacy attempt safety - reject legacy unverified attempts fail-closed
    if (existingJob.legacyAttemptsUnknown === true) {
      return res.status(409).json({
        success: false,
        error: 'LEGACY_ATTEMPTS_EXHAUSTED',
        message: `Job ${cleanShortId} belongs to a legacy transaction with unverified attempts and cannot be dispatched.`
      });
    }
    if (existingJob.payment && existingJob.payment.legacyAttemptsUnknown === true) {
      return res.status(409).json({
        success: false,
        error: 'LEGACY_ATTEMPTS_EXHAUSTED',
        message: `Job ${cleanShortId} parent payment has unverified legacy attempts and cannot be dispatched.`
      });
    }

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
      if (existingJob.payment && (existingJob.payment.authorizedPrintAttempts || 0) >= maxAttempts) {
        return res.status(409).json({
          success: false,
          error: 'MAX_PRINT_ATTEMPTS_EXCEEDED',
          message: `Maximum ${maxAttempts} print attempts exceeded for payment transaction ${existingJob.paymentId}.`,
          attempts: existingJob.payment.authorizedPrintAttempts,
          maxAttempts
        });
      }
    }

    // Payment validation: Verify payment is successfully confirmed before dispatch
    if (existingJob.paymentId) {
      if (!existingJob.payment || existingJob.payment.status !== 'SUCCESS') {
        return res.status(400).json({
          success: false,
          error: 'PAYMENT_NOT_CONFIRMED',
          message: `Cannot dispatch job ${cleanShortId}: Payment status is '${existingJob.payment?.status || 'UNKNOWN'}', expected 'SUCCESS'.`
        });
      }
    } else {
      // UP-04 Safety: Commercial prints require payment. Only test jobs (isTest: true) or zero-cost prints may dispatch without payment.
      if (existingJob.cost > 0 && !existingJob.isTest) {
        return res.status(400).json({
          success: false,
          error: 'PAYMENT_REQUIRED',
          message: `Cannot dispatch job ${cleanShortId}: Commercial print job requires a confirmed payment transaction.`
        });
      }
    }

    // UP-04: Authorized operator retry when job was in FAILED
    let restoredFromFailed = false;
    if (existingJob.status === 'FAILED') {
      const reasonValidation = validateOperatorReason(reason);
      if (!reasonValidation.valid) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_OPERATOR_REASON',
          message: reasonValidation.error
        });
      }

      // Durable transactional retry authorization: claim status + commit mandatory audit records
      try {
        await prisma.$transaction(async (tx) => {
          // Re-verify Payment-level invariants and lock inside transaction
          if (existingJob.paymentId) {
            // Acquire identical transaction advisory lock as refund.service.js to synchronize concurrent retry vs refund
            if (typeof tx.$executeRawUnsafe === 'function') {
              await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('payment_refund_${existingJob.paymentId}'))`);
            }

            const paymentRecord = await tx.payment.findUnique({
              where: { id: existingJob.paymentId },
              select: { id: true, status: true, authorizedPrintAttempts: true, legacyAttemptsUnknown: true }
            });

            if (!paymentRecord || paymentRecord.status !== 'SUCCESS') {
              const err = new Error(`Cannot retry job ${cleanShortId}: Payment status is '${paymentRecord?.status || 'NOT_FOUND'}', expected 'SUCCESS'.`);
              err.code = 'PAYMENT_NOT_CONFIRMED';
              err.statusCode = 400;
              throw err;
            }

            if (paymentRecord.legacyAttemptsUnknown) {
              const err = new Error(`Payment transaction ${existingJob.paymentId} has unverified legacy attempt history.`);
              err.code = 'LEGACY_ATTEMPTS_EXHAUSTED';
              err.statusCode = 409;
              throw err;
            }

            if (paymentRecord.authorizedPrintAttempts >= maxAttempts) {
              const err = new Error(`Maximum ${maxAttempts} print attempts exceeded for payment transaction ${existingJob.paymentId}.`);
              err.code = 'MAX_PRINT_ATTEMPTS_EXCEEDED';
              err.statusCode = 409;
              err.attempts = paymentRecord.authorizedPrintAttempts;
              err.maxAttempts = maxAttempts;
              throw err;
            }

            // Mutual safety with refunds: cannot retry if refund is active or completed
            const activeRefund = await tx.refund.findFirst({
              where: {
                paymentId: existingJob.paymentId,
                status: { in: ['SUCCESS', 'PROCESSING', 'PENDING'] }
              }
            });
            if (activeRefund) {
              const err = new Error(`Cannot retry job ${cleanShortId}: Payment transaction ${existingJob.paymentId} has an active or completed refund.`);
              err.code = 'PAYMENT_ALREADY_REFUNDED';
              err.statusCode = 400;
              throw err;
            }

            // Check sibling jobs total attempts sum
            const siblingJobs = await tx.printJob.findMany({
              where: { paymentId: existingJob.paymentId },
              select: { id: true, printAttempts: true }
            });
            const totalTxAttempts = siblingJobs.reduce((sum, j) => sum + (j.printAttempts || 0), 0);
            if (totalTxAttempts >= maxAttempts) {
              const err = new Error(`Maximum ${maxAttempts} print attempts exceeded for payment transaction ${existingJob.paymentId}. Total attempts: ${totalTxAttempts}, maximum: ${maxAttempts}.`);
              err.code = 'MAX_PRINT_ATTEMPTS_EXCEEDED';
              err.statusCode = 409;
              err.attempts = totalTxAttempts;
              err.maxAttempts = maxAttempts;
              throw err;
            }

            // Atomically reserve 1 attempt on Payment record inside transaction before commit
            const payRes = await tx.payment.updateMany({
              where: {
                id: existingJob.paymentId,
                status: 'SUCCESS',
                authorizedPrintAttempts: { lt: maxAttempts },
                legacyAttemptsUnknown: false
              },
              data: {
                authorizedPrintAttempts: { increment: 1 }
              }
            });

            if (payRes.count === 0) {
              const freshPayment = await tx.payment.findUnique({
                where: { id: existingJob.paymentId },
                select: { authorizedPrintAttempts: true, legacyAttemptsUnknown: true }
              });
              if (freshPayment?.legacyAttemptsUnknown) {
                const err = new Error(`Payment transaction ${existingJob.paymentId} has unverified legacy attempt history.`);
                err.code = 'LEGACY_ATTEMPTS_EXHAUSTED';
                err.statusCode = 409;
                throw err;
              }
              const attempts = freshPayment?.authorizedPrintAttempts ?? maxAttempts;
              const err = new Error(`Maximum ${maxAttempts} print attempts exceeded for payment transaction ${existingJob.paymentId}. Total attempts: ${attempts}.`);
              err.code = 'MAX_PRINT_ATTEMPTS_EXCEEDED';
              err.statusCode = 409;
              err.attempts = attempts;
              err.maxAttempts = maxAttempts;
              throw err;
            }
          }

          // 1. Conditional atomic update with expected previous status
          // reservedForRetry: true is set atomically here so the reconciler can
          // distinguish this specific job's reservation without an aggregate heuristic.
          const retryClaim = await tx.printJob.updateMany({
            where: {
              id: existingJob.id,
              status: 'FAILED',
              legacyAttemptsUnknown: false,
              printAttempts: { lt: maxAttempts }
            },
            data: { status: 'WAITING', reservedForRetry: true }
          });

          if (retryClaim.count === 0) {
            const err = new Error(`Job ${cleanShortId} could not be claimed for retry (concurrent modification or attempt ceiling reached).`);
            err.code = 'RETRY_CLAIM_FAILED';
            err.statusCode = 409;
            throw err;
          }

          // 2. Durable audit trail: ActivityLog (must succeed or rollback transaction)
          if (tx.activityLog) {
            let validUserId = null;
            if (req.user?.id) {
              if (tx.user && typeof tx.user.findUnique === 'function') {
                const u = await tx.user.findUnique({ where: { id: req.user.id } });
                if (u) validUserId = req.user.id;
              } else {
                validUserId = req.user.id;
              }
            }
            await tx.activityLog.create({
              data: {
                action: 'PRINT_JOB_AUTHORIZED_RETRY',
                details: JSON.stringify({
                  jobId: existingJob.id,
                  shortId: cleanShortId,
                  operatorId: req.user?.id || 'SUPERADMIN',
                  operatorRole: req.user?.role || 'SUPERADMIN',
                  operatorReason: reasonValidation.sanitized,
                  currentAttempts,
                  maxAttempts,
                  previousStatus: 'FAILED',
                  newStatus: 'WAITING'
                }),
                userId: validUserId,
                machineId: existingJob.machineId || null
              }
            });
          }

          // 3. Durable audit trail: PrintHistory (must succeed or rollback transaction)
          if (tx.printHistory) {
            await tx.printHistory.create({
              data: {
                printJobId: existingJob.id,
                success: false,
                errorDetails: `Authorized operator retry: ${reasonValidation.sanitized}`,
                completedAt: new Date()
              }
            });
          }
        }, { maxWait: 5000, timeout: 10000 });
        restoredFromFailed = true;
      } catch (txErr) {
        if (
          txErr.code === 'RETRY_CLAIM_FAILED' ||
          txErr.code === 'MAX_PRINT_ATTEMPTS_EXCEEDED' ||
          txErr.code === 'PAYMENT_NOT_CONFIRMED' ||
          txErr.code === 'PAYMENT_ALREADY_REFUNDED' ||
          txErr.code === 'LEGACY_ATTEMPTS_EXHAUSTED'
        ) {
          return res.status(txErr.statusCode || 409).json({
            success: false,
            error: txErr.code,
            message: txErr.message,
            attempts: txErr.attempts,
            maxAttempts: txErr.maxAttempts || maxAttempts
          });
        }
        console.error('Failed to commit retry authorization transaction:', txErr);
        return res.status(500).json({
          success: false,
          error: 'RETRY_TRANSACTION_FAILED',
          message: `Failed to commit retry authorization and audit records: ${txErr.message}`
        });
      }
    }

    let dispatchResult;
    try {
      dispatchResult = await startPrintingProcess(cleanShortId, req.app.get('io'), { isAuthorizedRetry: restoredFromFailed });
    } catch (dispatchError) {
      // Ensure exceptions during queue submission do not leave job stranded in WAITING
      if (restoredFromFailed) {
        await prisma.printJob.updateMany({
          where: { id: existingJob.id, status: 'WAITING' },
          data: { status: 'FAILED' }
        }).catch(err => console.error(`Rollback error for stranded job ${cleanShortId}:`, err));

        if (prisma.printHistory) {
          await prisma.printHistory.create({
            data: {
              printJobId: existingJob.id,
              success: false,
              errorDetails: `Dispatch exception rollback to FAILED: ${dispatchError.message}`,
              completedAt: new Date()
            }
          }).catch(() => {});
        }
      }
      throw dispatchError;
    }

    if (dispatchResult && dispatchResult.success === false) {
      if (restoredFromFailed) {
        await prisma.printJob.updateMany({
          where: { id: existingJob.id, status: 'WAITING' },
          data: { status: 'FAILED' }
        }).catch(err => console.error(`Rollback error for failed dispatch ${cleanShortId}:`, err));

        if (prisma.printHistory) {
          await prisma.printHistory.create({
            data: {
              printJobId: existingJob.id,
              success: false,
              errorDetails: `Dispatch refused rollback to FAILED [${dispatchResult.code}]: ${dispatchResult.message}`,
              completedAt: new Date()
            }
          }).catch(() => {});
        }
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
