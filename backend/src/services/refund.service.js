/**
 * Refund Service
 * Phase 4A: Financial Recovery, Multi-Partial Refunds, Idempotency & Gateway Integration
 */

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
      logger.info(`Idempotent refund request recognized for key: ${idempotencyKey}`);
      return existingRefund;
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

  // 4. Safe Decimal Balance Calculation
  const paymentCents = toCents(payment.amount);
  
  // Calculate existing non-failed refunds
  const activeExistingRefunds = payment.refunds.filter(
    r => r.status === 'SUCCESS' || r.status === 'PROCESSING' || r.status === 'PENDING'
  );
  const existingRefundedCents = activeExistingRefunds.reduce((sum, r) => sum + toCents(r.amount), 0);
  const remainingCents = paymentCents - existingRefundedCents;
  const remainingAmount = fromCents(remainingCents);

  if (remainingCents <= 0) {
    throw new AppError('Payment is already fully refunded', 400);
  }

  // Determine requested refund amount
  const requestedCents = amount !== undefined && amount !== null
    ? toCents(amount)
    : remainingCents;

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

  const finalRefundAmount = fromCents(requestedCents);
  const uniqueRefundId = `ref_${payment.gatewayOrderId || payment.id.slice(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  // 5. TRANSACTIONAL ADVISORY LOCKING & GATEWAY DISPATCH
  const result = await prisma.$transaction(async (tx) => {
    // Acquire exclusive transaction advisory lock scoped to this specific payment
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('payment_refund_${payment.id}'))`);

    // Re-verify idempotency inside lock
    if (idempotencyKey) {
      const freshExisting = await tx.refund.findUnique({ where: { idempotencyKey } });
      if (freshExisting) return freshExisting;
    }

    // Re-verify remaining balance inside lock to prevent concurrent over-refunds
    const freshRefunds = await tx.refund.findMany({
      where: {
        paymentId: payment.id,
        status: { in: ['SUCCESS', 'PROCESSING', 'PENDING'] }
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

    // Create local PENDING Refund record
    const createdRefund = await tx.refund.create({
      data: {
        idempotencyKey: idempotencyKey || null,
        paymentId: payment.id,
        printJobId: payment.printJobs?.[0]?.id || null,
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

    return createdRefund;
  });

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
    gatewayResult = {
      success: false,
      status: 'FAILED',
      error: err.message,
      rawResponse: { error: err.message }
    };
  }

  // 7. FINALIZE REFUND STATE AND TRIGGER CREDIT NOTE
  const finalized = await prisma.$transaction(async (tx) => {
    // Re-acquire advisory lock to update payment and invoice status
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

      return updatedRefund;
    } else {
      // Gateway Failure or Timeout
      const isTimeout = gatewayResult.isTimeout;
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
            details: JSON.stringify({ error: cnError.message, refundAmount: finalized.amount })
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
