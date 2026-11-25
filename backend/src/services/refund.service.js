/**
 * Refund Service
 * Phase 4A: Financial Recovery, Multi-Partial Refunds, Idempotency & Gateway Integration
 */

const crypto = require('crypto');
const prisma = require('../utils/prisma');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const cashfreeGateway = require('./cashfreeGateway.adapter');
const { issueCreditNoteForInvoice } = require('./invoice.service');
const { redactSensitiveData } = require('../config/cashfree.config');

/**
 * Helper to compute safe decimal amounts rounded to 2 decimal places.
 */
const toCents = (amt) => Math.round(Number(amt) * 100);
const fromCents = (cents) => Math.round(cents) / 100;

/**
 * Initiates a full or partial refund against a verified payment.
 * Enforces transaction-level advisory locks to eliminate concurrency race conditions.
 */
const createRefund = async (params) => {
  const {
    paymentId,
    printJobId = null,
    amount,
    reason = 'Customer Requested Refund',
    idempotencyKey = null,
    user = null,
    initiatedBy = 'ADMIN'
  } = params;

  if (!paymentId) throw new AppError('Payment ID is required', 400);

  // 1. Check Idempotency Key before acquiring heavy locks
  if (idempotencyKey) {
    const existingRefund = await prisma.refund.findUnique({
      where: { idempotencyKey },
      include: { creditNotes: true, payment: true }
    });
    if (existingRefund) {
      // Validate payment ownership: key must belong to the requested payment
      if (existingRefund.paymentId !== paymentId) {
        throw new AppError(`Idempotency key '${idempotencyKey}' is already bound to another payment (${existingRefund.paymentId}). Cross-payment key reuse is forbidden.`, 409);
      }
      if (existingRefund.status === 'SUCCESS' || existingRefund.status === 'PROCESSING') {
        logger.info(`Idempotent refund request recognized for key: ${idempotencyKey} (Status: ${existingRefund.status})`);
        return existingRefund;
      }
      if (existingRefund.status === 'FAILED') {
        if (!existingRefund.retryEligible) {
          logger.warn(`Idempotent refund retry rejected: record ${existingRefund.id} is marked not retryEligible for key: ${idempotencyKey}`);
          return existingRefund;
        }
        // retryEligible is true: proceed to transactional lock for atomic retry claim
      }
    }
  }

  // 2. Fetch Payment with related Job and existing Refunds
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      refunds: true,
      printJobs: { include: { invoice: true, machine: true } }
    }
  });

  if (!payment) throw new AppError('Payment record not found', 404);

  // 3. Strict Payment Status & Eligibility Rules
  if (payment.status !== 'SUCCESS' && payment.status !== 'PARTIALLY_REFUNDED') {
    throw new AppError(`Cannot refund payment: Current status is '${payment.status}'. Only SUCCESS payments are refundable.`, 400);
  }

  // Demo / Simulated payments must NEVER trigger real financial refunds
  const isDemo = payment.paymentMethod === 'demo' ||
                 payment.paymentGroup === 'simulated' ||
                 (payment.gatewayOrderId && payment.gatewayOrderId.startsWith('demo_order_'));

  if (isDemo) {
    logger.warn(`Security alert: Attempted financial refund against simulated demo payment ${payment.id}`);
    throw new AppError('Demo/simulated payments cannot be processed through real financial refund channels', 400);
  }

  // C-02: Explicit printJobId ownership & validation
  let targetJob = null;
  if (printJobId) {
    targetJob = payment.printJobs?.find(j => j.id === printJobId);
    if (!targetJob) {
      throw new AppError(`Specified printJobId '${printJobId}' does not belong to Payment '${paymentId}'`, 400);
    }
  } else {
    // If not explicitly provided, reject ambiguous multi-job payments
    if (payment.printJobs && payment.printJobs.length > 1) {
      throw new AppError('Payment is associated with multiple print jobs; explicit printJobId is required to prevent ambiguous refund attribution', 400);
    }
    targetJob = payment.printJobs?.[0] || null;
  }

  // 4. Safe Decimal Balance Calculation (Payment & Job-level caps)
  const paymentCents = toCents(payment.amount);
  
  // Calculate existing non-failed refunds for the payment
  const activeExistingRefunds = payment.refunds.filter(
    r => r.status === 'SUCCESS' || r.status === 'PROCESSING' || r.status === 'PENDING'
  );
  const existingRefundedCents = activeExistingRefunds.reduce((sum, r) => sum + toCents(r.amount), 0);
  const remainingCents = paymentCents - existingRefundedCents;
  const remainingAmount = fromCents(remainingCents);

  if (remainingCents <= 0) {
    throw new AppError('Payment is already fully refunded', 400);
  }

  // C-03: Per-Job Cumulative Cap Calculation
  let remainingJobCents = null;
  if (targetJob) {
    const jobCostCents = toCents(targetJob.cost);
    const activeJobRefunds = payment.refunds.filter(
      r => r.printJobId === targetJob.id && (r.status === 'SUCCESS' || r.status === 'PROCESSING' || r.status === 'PENDING')
    );
    const existingJobRefundedCents = activeJobRefunds.reduce((sum, r) => sum + toCents(r.amount), 0);
    remainingJobCents = jobCostCents - existingJobRefundedCents;

    if (remainingJobCents <= 0) {
      throw new AppError(`Print job '${targetJob.shortId || targetJob.id}' is already fully refunded`, 400);
    }
  }

  // Determine requested refund amount
  const requestedCents = amount !== undefined && amount !== null
    ? toCents(amount)
    : (remainingJobCents !== null ? Math.min(remainingCents, remainingJobCents) : remainingCents);

  if (isNaN(requestedCents) || requestedCents <= 0) {
    throw new AppError('Refund amount must be a positive number greater than zero', 400);
  }

  if (requestedCents > remainingCents) {
    const reqAmount = fromCents(requestedCents);
    throw new AppError(
      `Requested refund amount (Rs. ${reqAmount.toFixed(2)}) exceeds remaining refundable balance (Rs. ${remainingAmount.toFixed(2)})`,
      400
    );
  }

  if (remainingJobCents !== null && requestedCents > remainingJobCents) {
    const reqAmount = fromCents(requestedCents);
    const remJobAmount = fromCents(remainingJobCents);
    throw new AppError(
      `Requested refund amount (Rs. ${reqAmount.toFixed(2)}) exceeds remaining refundable balance for print job (Rs. ${remJobAmount.toFixed(2)})`,
      400
    );
  }

  const finalRefundAmount = fromCents(requestedCents);
  const nonce = crypto.randomBytes(3).toString('hex');
  const sanitizedOrderId = (payment.gatewayOrderId || payment.id.slice(0, 8)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 14);
  const uniqueRefundId = `ref_${sanitizedOrderId}_${Date.now()}_${nonce}`.slice(0, 40);

  // 5. TRANSACTIONAL ADVISORY LOCKING & GATEWAY DISPATCH
  const claimResult = await prisma.$transaction(async (tx) => {
    // Acquire hierarchical advisory locks: Tier 1 printjob_refund_ then Tier 2 payment_refund_
    if (targetJob) {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('printjob_refund_${targetJob.id}'))`);
    }
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('payment_refund_${payment.id}'))`);

    // Re-verify idempotency inside lock
    let claimedRefund = null;
    if (idempotencyKey) {
      const freshExisting = await tx.refund.findUnique({ where: { idempotencyKey } });
      if (freshExisting) {
        // Enforce payment ownership inside lock before any state change
        if (freshExisting.paymentId !== payment.id) {
          throw new AppError(`Idempotency key '${idempotencyKey}' is already bound to another payment (${freshExisting.paymentId}). Cross-payment key reuse is forbidden.`, 409);
        }
        if (freshExisting.status === 'SUCCESS' || freshExisting.status === 'PROCESSING') {
          return { refund: freshExisting, isClaimedOrCreated: false };
        }
        if (freshExisting.status === 'FAILED') {
          if (!freshExisting.retryEligible) {
            return { refund: freshExisting, isClaimedOrCreated: false };
          }
          // Atomic claim for retry: transition status to PROCESSING and clear retryEligible
          claimedRefund = await tx.refund.update({
            where: { id: freshExisting.id },
            data: {
              status: 'PROCESSING',
              retryEligible: false,
              amount: finalRefundAmount,
              gatewayRefundId: uniqueRefundId,
              failureReason: null,
              initiatedBy: user?.id || initiatedBy
            }
          });
        }
      }
    }

    // Re-verify remaining balance inside lock to prevent concurrent over-refunds
    const freshRefunds = await tx.refund.findMany({
      where: {
        paymentId: payment.id,
        status: { in: ['SUCCESS', 'PROCESSING', 'PENDING'] },
        ...(claimedRefund ? { id: { not: claimedRefund.id } } : {})
      }
    });
    const freshCreditedCents = freshRefunds.reduce((sum, r) => sum + toCents(r.amount), 0);
    const freshRemainingCents = paymentCents - freshCreditedCents;

    if (requestedCents > freshRemainingCents) {
      throw new AppError(
        `Concurrent refund rejected: Requested Rs. ${finalRefundAmount.toFixed(2)} exceeds live remaining balance Rs. ${fromCents(freshRemainingCents).toFixed(2)}`,
        400
      );
    }

    // Re-verify live per-job cumulative cap inside lock
    if (targetJob) {
      const freshJobRefunds = freshRefunds.filter(r => r.printJobId === targetJob.id);
      const freshJobCreditedCents = freshJobRefunds.reduce((sum, r) => sum + toCents(r.amount), 0);
      const freshJobRemainingCents = toCents(targetJob.cost) - freshJobCreditedCents;

      if (requestedCents > freshJobRemainingCents) {
        throw new AppError(
          `Concurrent refund rejected: Requested Rs. ${finalRefundAmount.toFixed(2)} exceeds live remaining balance for print job Rs. ${fromCents(freshJobRemainingCents).toFixed(2)}`,
          400
        );
      }
    }

    if (claimedRefund) {
      await tx.transaction.create({
        data: {
          paymentId: payment.id,
          action: 'REFUND_RETRY_INITIATED',
          status: 'PENDING',
          amount: finalRefundAmount,
          gatewayPaymentId: payment.gatewayPaymentId,
          ipAddress: user?.ip || null
        }
      });
      return { refund: claimedRefund, isClaimedOrCreated: true };
    }

    // Create local PENDING Refund record (Strictly no arbitrary fallback)
    const createdRefund = await tx.refund.create({
      data: {
        idempotencyKey: idempotencyKey || null,
        paymentId: payment.id,
        printJobId: targetJob ? targetJob.id : null,
        gatewayRefundId: uniqueRefundId,
        amount: finalRefundAmount,
        currency: payment.currency || 'INR',
        reason,
        status: 'PROCESSING',
        initiatedBy: user?.id || initiatedBy,
        retryEligible: false
      }
    });

    // Create Transaction audit entry
    await tx.transaction.create({
      data: {
        paymentId: payment.id,
        action: 'REFUND_INITIATED',
        status: 'PENDING',
        amount: finalRefundAmount,
        gatewayPaymentId: payment.gatewayPaymentId,
        ipAddress: user?.ip || null
      }
    });

    return { refund: createdRefund, isClaimedOrCreated: true };
  });

  // If another concurrent caller already completed the refund or is processing it:
  if (!claimResult.isClaimedOrCreated) {
    return claimResult.refund;
  }
  const result = claimResult.refund;

  // 6. CALL GATEWAY ADAPTER (OUTSIDE DB TRANSACTION TO PREVENT CONNECTION POOL EXHAUSTION)
  let gatewayResult;
  try {
    gatewayResult = await cashfreeGateway.createRefund({
      orderId: payment.gatewayOrderId,
      refundId: uniqueRefundId,
      amount: finalRefundAmount,
      reason
    });
  } catch (err) {
    logger.error(`Cashfree Gateway refund invocation threw unexpected error: ${err.message}`);
    const isTimeout = err.code === 'ECONNABORTED' || Boolean(err.message?.includes('timeout'));
    gatewayResult = {
      success: false,
      status: isTimeout ? 'PROCESSING' : 'FAILED',
      isTimeout,
      error: err.message,
      rawResponse: { error: err.message }
    };
  }

  // 7. FINALIZE REFUND STATE AND TRIGGER CREDIT NOTE
  const finalized = await prisma.$transaction(async (tx) => {
    // Re-acquire hierarchical advisory locks to update payment and invoice status
    if (targetJob) {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('printjob_refund_${targetJob.id}'))`);
    }
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('payment_refund_${payment.id}'))`);

    if (gatewayResult.success) {
      const isGatewayPending = gatewayResult.status === 'PENDING';
      const finalStatus = isGatewayPending ? 'PROCESSING' : 'SUCCESS';

      const updatedRefund = await tx.refund.update({
        where: { id: result.id },
        data: {
          status: finalStatus,
          cfRefundId: gatewayResult.cfRefundId || null,
          gatewayResponse: redactSensitiveData(gatewayResult.rawResponse),
          processedAt: new Date()
        }
      });

      // Update Transaction audit
      await tx.transaction.create({
        data: {
          paymentId: payment.id,
          action: isGatewayPending ? 'REFUND_PROCESSING' : 'REFUND_SUCCESS',
          status: finalStatus,
          amount: finalRefundAmount,
          gatewayPaymentId: payment.gatewayPaymentId,
          gatewayResponse: redactSensitiveData(gatewayResult.rawResponse)
        }
      });

      // Calculate new remaining balance
      const allSuccessfulRefunds = await tx.refund.findMany({
        where: { paymentId: payment.id, status: 'SUCCESS' }
      });
      const totalSuccessfulCents = allSuccessfulRefunds.reduce((sum, r) => sum + toCents(r.amount), 0);
      const isFullyRefunded = totalSuccessfulCents >= paymentCents;

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: isFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED' }
      });

      if (tx.reconciliationRecord) {
        await tx.reconciliationRecord.updateMany({
          where: {
            OR: [
              { refundId: result.id },
              { paymentId: payment.id, discrepancyType: 'FAILED_AUTOMATIC_REFUND' }
            ],
            resolved: false
          },
          data: {
            resolved: true,
            resolvedAt: new Date(),
            resolvedBy: user?.id || initiatedBy || 'SYSTEM_RETRY',
            resolutionNotes: 'Resolved automatically via successful refund retry',
            dispatchState: 'GATEWAY_CONFIRMED'
          }
        }).catch(() => {});
      }

      return updatedRefund;
    } else {
      // Gateway Failure or Timeout
      const isTimeout = Boolean(gatewayResult.isTimeout || gatewayResult.status === 'TIMEOUT' || gatewayResult.status === 'PROCESSING');
      const finalStatus = isTimeout ? 'PROCESSING' : 'FAILED';

      const updatedRefund = await tx.refund.update({
        where: { id: result.id },
        data: {
          status: finalStatus,
          failureReason: gatewayResult.error || 'Gateway rejected refund',
          retryEligible: !isTimeout,
          gatewayResponse: redactSensitiveData(gatewayResult.rawResponse)
        }
      });

      await tx.transaction.create({
        data: {
          paymentId: payment.id,
          action: isTimeout ? 'REFUND_TIMEOUT_RETAINED' : 'REFUND_FAILED',
          status: 'FAILED',
          amount: finalRefundAmount,
          errorMessage: gatewayResult.error || 'Gateway refund failure',
          gatewayResponse: redactSensitiveData(gatewayResult.rawResponse)
        }
      });

      // If ambiguous timeout/processing outcome, record discrepancy for inquiry recovery
      if (isTimeout && tx.reconciliationRecord) {
        await tx.reconciliationRecord.create({
          data: {
            paymentId: payment.id,
            refundId: result.id,
            printJobId: targetJob ? targetJob.id : null,
            status: 'PENDING_RECONCILIATION',
            discrepancyType: 'AMBIGUOUS_GATEWAY_OUTCOME',
            details: JSON.stringify({
              reason: 'Gateway timeout during refund dispatch. Inquiry verification required.',
              refundId: result.id,
              gatewayOrderId: payment.gatewayOrderId,
              gatewayRefundId: uniqueRefundId
            }),
            resolved: false,
            dispatchState: 'OUTCOME_UNKNOWN'
          }
        }).catch(() => {});
      }

      return updatedRefund;
    }
  });

  // 8. AUTOMATIC CREDIT NOTE GENERATION UPON SUCCESSFUL REFUND
  if (finalized.status === 'SUCCESS') {
    const jobWithInvoice = payment.printJobs?.find(j => j.invoice);
    if (jobWithInvoice && jobWithInvoice.invoice) {
      try {
        await issueCreditNoteForInvoice(jobWithInvoice.invoice.id, {
          refundId: finalized.id,
          amount: finalized.amount,
          reason,
          user
        });
        logger.info(`Statutory Credit Note issued for refund ${finalized.id} (amount: Rs. ${finalized.amount})`);
      } catch (cnError) {
        logger.error(`Failed to issue Credit Note for successful refund ${finalized.id}: ${cnError.message}`);
        // Record discrepancy for reconciliation engine
        await prisma.reconciliationRecord.create({
          data: {
            paymentId: payment.id,
            refundId: finalized.id,
            printJobId: jobWithInvoice.id,
            status: 'PENDING_RECONCILIATION',
            discrepancyType: 'MISSING_CREDIT_NOTE',
            details: JSON.stringify({ error: cnError.message, refundAmount: finalized.amount }),
            resolved: false,
            dispatchState: 'GATEWAY_CONFIRMED'
          }
        }).catch(() => {});
      }
    }
  }

  return finalized;
};

/**
 * Returns paginated refunds with tenant-aware authorization filters.
 */
const getRefunds = async (options = {}) => {
  const { page = 1, limit = 20, status, paymentId, user } = options;
  const skip = (Math.max(1, page) - 1) * limit;

  const where = {};
  if (status) where.status = status;
  if (paymentId) where.paymentId = paymentId;

  // Tenant Isolation: FRANCHISEE can only view refunds on machines belonging to their company
  if (user && user.role === 'FRANCHISEE') {
    where.payment = {
      printJobs: {
        some: {
          machine: { companyId: user.companyId }
        }
      }
    };
  }

  const [refunds, total] = await Promise.all([
    prisma.refund.findMany({
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
            gatewayOrderId: true,
            paymentMethod: true
          }
        },
        creditNotes: true
      }
    }),
    prisma.refund.count({ where })
  ]);

  return {
    success: true,
    refunds,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  };
};

/**
 * Retrieves a single refund by ID with tenant security check.
 */
const getRefundById = async (id, user) => {
  const refund = await prisma.refund.findUnique({
    where: { id },
    include: {
      payment: {
        include: {
          printJobs: { include: { machine: true, invoice: true } }
        }
      },
      creditNotes: true
    }
  });

  if (!refund) throw new AppError('Refund record not found', 404);

  // Tenant authorization check
  if (user && user.role === 'FRANCHISEE') {
    const isOwner = refund.payment?.printJobs?.some(
      j => j.machine?.companyId === user.companyId
    );
    if (!isOwner) throw new AppError('Unauthorized: Refund does not belong to your company', 403);
  }

  return refund;
};

module.exports = {
  createRefund,
  getRefunds,
  getRefundById
};
