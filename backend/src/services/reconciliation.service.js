/**
 * Financial Reconciliation Engine
 * Phase 4D: Ledger Comparison, Gateway Verification, Discrepancy Escalation
 */

const prisma = require('../utils/prisma');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const cashfreeGateway = require('./cashfreeGateway.adapter');
const { issueCreditNoteForInvoice } = require('./invoice.service');
const { redactSensitiveData } = require('../config/cashfree.config');

/**
 * Runs reconciliation across Payments, Refunds, Ledger, and Gateway records.
 * Uses append-only ReconciliationRecord entries.
 */
const runReconciliation = async (options = {}) => {
  const { limit = 50, dryRun = false } = options;
  const findings = [];

  logger.info(`Starting financial reconciliation run (limit: ${limit}, dryRun: ${dryRun})`);

  // 1. RECONCILE PAYMENTS
  const payments = await prisma.payment.findMany({
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      transactions: true,
      refunds: true,
      printJobs: { include: { invoice: true } }
    }
  });

  for (const payment of payments) {
    // Safety Guard: Historical ambiguous print job ab36197e must NEVER be touched
    const isHistoricalAb36 = payment.printJobs?.some(j => j.shortId === 'ab36197e');
    if (isHistoricalAb36) {
      continue;
    }

    // Skip simulated demo payments from real gateway checks
    const isDemo = payment.paymentMethod === 'demo' ||
                   payment.paymentGroup === 'simulated' ||
                   (payment.gatewayOrderId && payment.gatewayOrderId.startsWith('demo_order_'));

    if (isDemo) {
      // For demo payments, verify internal ledger consistency
      const hasTx = payment.transactions.length > 0;
      if (!hasTx && payment.status === 'SUCCESS') {
        const record = await recordDiscrepancy({
          paymentId: payment.id,
          status: 'PENDING_RECONCILIATION',
          discrepancyType: 'MISSING_TRANSACTION',
          details: { message: 'Demo payment SUCCESS has no Transaction ledger entry' },
          dryRun
        });
        findings.push(record);
      }
      continue;
    }

    // A. Check Missing Transaction Ledger Entry
    if (payment.status === 'SUCCESS' && payment.transactions.length === 0) {
      const record = await recordDiscrepancy({
        paymentId: payment.id,
        status: 'PENDING_RECONCILIATION',
        discrepancyType: 'MISSING_TRANSACTION',
        details: { message: `Payment ${payment.id} is SUCCESS but has zero transactions in ledger` },
        dryRun
      });
      findings.push(record);
    }

    // B. Reconcile with Gateway for non-demo paid orders
    if (payment.gatewayOrderId && payment.status === 'SUCCESS') {
      const gwCheck = await cashfreeGateway.getOrderPayments(payment.gatewayOrderId);
      if (gwCheck.success && gwCheck.payments && gwCheck.payments.length > 0) {
        const gwSuccessPayment = gwCheck.payments.find(p => p.payment_status === 'SUCCESS');
        
        if (!gwSuccessPayment) {
          const record = await recordDiscrepancy({
            paymentId: payment.id,
            status: 'GATEWAY_MISMATCH',
            discrepancyType: 'GATEWAY_PAYMENT_NOT_CONFIRMED',
            details: { message: 'Internal Payment is SUCCESS but Gateway reports no successful payment' },
            dryRun
          });
          findings.push(record);
        } else {
          // Check Amount Match
          const gwAmount = Number(gwSuccessPayment.payment_amount);
          if (Math.abs(payment.amount - gwAmount) > 0.01) {
            const record = await recordDiscrepancy({
              paymentId: payment.id,
              status: 'AMOUNT_MISMATCH',
              discrepancyType: 'PAYMENT_AMOUNT_MISMATCH',
              details: { internalAmount: payment.amount, gatewayAmount: gwAmount },
              dryRun
            });
            findings.push(record);
          }
        }
      }
    }
  }

  // 2. RECONCILE REFUNDS
  const refunds = await prisma.refund.findMany({
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      payment: {
        include: { printJobs: { include: { invoice: true } } }
      },
      creditNotes: true
    }
  });

  for (const refund of refunds) {
    // A. Check for Missing Credit Note on Successful Refunds with Invoices
    if (refund.status === 'SUCCESS') {
      const jobWithInvoice = refund.payment?.printJobs?.find(j => j.invoice);
      if (jobWithInvoice && jobWithInvoice.invoice && refund.creditNotes.length === 0) {
        if (!dryRun) {
          try {
            // Automatic Safe Correction: Issue missing credit note
            await issueCreditNoteForInvoice(jobWithInvoice.invoice.id, {
              refundId: refund.id,
              amount: refund.amount,
              reason: 'Reconciliation Auto-Correction: Missing Credit Note'
            });
            logger.info(`Reconciliation auto-corrected missing credit note for refund ${refund.id}`);
          } catch (cnErr) {
            const record = await recordDiscrepancy({
              paymentId: refund.paymentId,
              refundId: refund.id,
              status: 'MANUAL_REVIEW_REQUIRED',
              discrepancyType: 'MISSING_CREDIT_NOTE',
              details: { error: cnErr.message, refundAmount: refund.amount },
              dryRun
            });
            findings.push(record);
          }
        } else {
          findings.push({
            refundId: refund.id,
            status: 'MANUAL_REVIEW_REQUIRED',
            discrepancyType: 'MISSING_CREDIT_NOTE',
            dryRun: true
          });
        }
      }
    }

    // B. Reconcile Gateway Refund State for PENDING / PROCESSING Refunds
    if ((refund.status === 'PENDING' || refund.status === 'PROCESSING') && refund.payment?.gatewayOrderId) {
      const gwRefund = await cashfreeGateway.getRefundDetails(refund.payment.gatewayOrderId, refund.gatewayRefundId);
      if (gwRefund.success && gwRefund.status === 'SUCCESS') {
        if (!dryRun) {
          // Automatic safe correction based on verified gateway evidence
          await prisma.$transaction(async (tx) => {
            await tx.refund.update({
              where: { id: refund.id },
              data: {
                status: 'SUCCESS',
                cfRefundId: gwRefund.cfRefundId,
                gatewayResponse: redactSensitiveData(gwRefund.rawResponse),
                processedAt: new Date()
              }
            });

            await tx.transaction.create({
              data: {
                paymentId: refund.paymentId,
                action: 'RECONCILIATION_REFUND_SUCCESS',
                status: 'SUCCESS',
                amount: refund.amount
              }
            });
          });

          // Issue Credit Note if invoice exists
          const jobWithInvoice = refund.payment?.printJobs?.find(j => j.invoice);
          if (jobWithInvoice && jobWithInvoice.invoice) {
            await issueCreditNoteForInvoice(jobWithInvoice.invoice.id, {
              refundId: refund.id,
              amount: refund.amount,
              reason: 'Reconciled Gateway Refund Success'
            }).catch(() => {});
          }

          logger.info(`Reconciliation updated pending refund ${refund.id} to SUCCESS based on gateway confirmation`);
        } else {
          findings.push({
            refundId: refund.id,
            status: 'PENDING_RECONCILIATION',
            discrepancyType: 'GATEWAY_REFUND_CONFIRMED_PENDING_LOCALLY',
            dryRun: true
          });
        }
      } else if (gwRefund.status === 'FAILED') {
        const record = await recordDiscrepancy({
          paymentId: refund.paymentId,
          refundId: refund.id,
          status: 'GATEWAY_MISMATCH',
          discrepancyType: 'GATEWAY_REFUND_FAILED',
          details: { error: gwRefund.error },
          dryRun
        });
        findings.push(record);
      }
    }
  }

  // 3. CHECK DUPLICATE WEBHOOK EVENTS
  const duplicateEvents = await prisma.paymentEvent.groupBy({
    by: ['gatewayOrderId', 'eventType'],
    _count: { id: true },
    having: { id: { _count: { gt: 1 } } }
  });

  for (const dup of duplicateEvents) {
    const record = await recordDiscrepancy({
      status: 'DUPLICATE_EVENT',
      discrepancyType: 'DUPLICATE_WEBHOOK_EVENT',
      details: { orderId: dup.gatewayOrderId, eventType: dup.eventType, count: dup._count.id },
      dryRun
    });
    findings.push(record);
  }

  logger.info(`Reconciliation run complete. Total discrepancies flagged: ${findings.length}`);
  return {
    success: true,
    totalDiscrepancies: findings.length,
    findings
  };
};

/**
 * Creates an append-only ReconciliationRecord if not in dryRun mode.
 */
const recordDiscrepancy = async ({ paymentId, refundId, printJobId, status, discrepancyType, details, dispatchState = null, dryRun }) => {
  if (dryRun) {
    return { paymentId, refundId, status, discrepancyType, details, dryRun: true };
  }

  // Idempotency: Don't duplicate open discrepancies for the same entity and type
  const existing = await prisma.reconciliationRecord.findFirst({
    where: {
      paymentId: paymentId || undefined,
      refundId: refundId || undefined,
      discrepancyType,
      resolved: false
    }
  });

  if (existing) return existing;

  // Determine safe dispatchState if not explicitly provided
  let effectiveDispatchState = dispatchState;
  if (!effectiveDispatchState) {
    if (discrepancyType === 'MISSING_CREDIT_NOTE') {
      effectiveDispatchState = 'GATEWAY_CONFIRMED';
    } else if (discrepancyType === 'GATEWAY_REFUND_FAILED') {
      effectiveDispatchState = 'GATEWAY_FAILED';
    } else if (discrepancyType === 'AMBIGUOUS_GATEWAY_OUTCOME') {
      effectiveDispatchState = 'OUTCOME_UNKNOWN';
    } else if (
      status === 'MANUAL_REVIEW_REQUIRED' ||
      discrepancyType === 'GATEWAY_PAYMENT_NOT_CONFIRMED' ||
      discrepancyType === 'PAYMENT_AMOUNT_MISMATCH' ||
      discrepancyType === 'DUPLICATE_WEBHOOK_EVENT'
    ) {
      effectiveDispatchState = 'MANUAL_REVIEW_REQUIRED';
    } else {
      effectiveDispatchState = 'NOT_DISPATCHED';
    }
  }

  return await prisma.reconciliationRecord.create({
    data: {
      paymentId: paymentId || null,
      refundId: refundId || null,
      printJobId: printJobId || null,
      status,
      discrepancyType,
      details: typeof details === 'string' ? details : JSON.stringify(details),
      resolved: false,
      dispatchState: effectiveDispatchState
    }
  });
};

/**
 * Resolves an open reconciliation record with operator reason and audit logging.
 */
const resolveDiscrepancy = async (recordId, options = {}) => {
  const { resolutionNotes, user } = options;

  if (!resolutionNotes || resolutionNotes.trim().length < 5) {
    throw new AppError('A valid resolution note explaining the correction is required (minimum 5 characters)', 400);
  }

  const record = await prisma.reconciliationRecord.findUnique({
    where: { id: recordId }
  });

  if (!record) throw new AppError('Reconciliation record not found', 404);
  if (record.resolved) throw new AppError('Reconciliation record is already resolved', 400);

  const updated = await prisma.reconciliationRecord.update({
    where: { id: recordId },
    data: {
      resolved: true,
      resolvedAt: new Date(),
      resolvedBy: user?.id || 'ADMIN',
      resolutionNotes: resolutionNotes.trim()
    }
  });

  // Record Admin Activity Log
  await prisma.activityLog.create({
    data: {
      userId: user?.id || 'ADMIN',
      action: 'RECONCILIATION_RESOLVED',
      details: `Resolved reconciliation discrepancy ${recordId} (${record.discrepancyType}): ${resolutionNotes.trim()}`
    }
  }).catch(() => {});

  logger.info(`Reconciliation record ${recordId} resolved by user ${user?.id || 'ADMIN'}`);
  return updated;
};

/**
 * Retrieves reconciliation records with pagination and status filtering.
 */
const getReconciliationRecords = async (options = {}) => {
  const { page = 1, limit = 20, status, resolved } = options;
  const skip = (Math.max(1, page) - 1) * limit;

  const where = {};
  if (status) where.status = status;
  if (resolved !== undefined) where.resolved = resolved === 'true' || resolved === true;

  const [records, total] = await Promise.all([
    prisma.reconciliationRecord.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        payment: {
          select: {
            id: true,
            amount: true,
            currency: true,
            status: true,
            gatewayOrderId: true
          }
        }
      }
    }),
    prisma.reconciliationRecord.count({ where })
  ]);

  return {
    success: true,
    records,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  };
};

const reconciliationWorker = require('./reconciliationWorker.service');

module.exports = {
  runReconciliation,
  resolveDiscrepancy,
  getReconciliationRecords,
  ...reconciliationWorker
};
