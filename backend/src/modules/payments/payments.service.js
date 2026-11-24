const axios = require('axios');
const prisma = require('../../utils/prisma');
const AppError = require('../../utils/AppError');
const logger = require('../../utils/logger');
const { isValidPaymentTransition, isValidJobTransition } = require('../../utils/stateMachine');
const refundService = require('../../services/refund.service');
const { computePrinterAvailability } = require('../../services/printerAvailability.service');
const {
  getCashfreeConfig,
  getPublicAppUrl,
  validateReturnUrl,
  redactSensitiveData
} = require('../../config/cashfree.config');
const { resolveCustomerDetails } = require('../../utils/customerContact');
const { persistCustomerForJob } = require('../../utils/customerPersistence');

/**
 * Resolves the PrintJob associated with a Payment across retry attempts
 * even if PrintJob.paymentId was subsequently updated to a newer attempt.
 */
const resolvePrintJobForPayment = async (db, payment) => {
  if (!payment) return null;

  if (Array.isArray(payment.printJobs) && payment.printJobs.length > 0) {
    return payment.printJobs[0];
  }

  if (db.printJob && typeof db.printJob.findFirst === 'function') {
    const byPaymentId = await db.printJob.findFirst({
      where: { paymentId: payment.id },
      include: { document: true, machine: true }
    });
    if (byPaymentId) return byPaymentId;
  }

  // Fallback 1: Inspect immutable Transaction metadata recorded during order creation
  if (db.transaction && typeof db.transaction.findFirst === 'function') {
    const creationTx = await db.transaction.findFirst({
      where: { paymentId: payment.id, action: 'ORDER_CREATION_ATTEMPT' },
      orderBy: { createdAt: 'asc' }
    });
    if (creationTx?.gatewayResponse) {
      try {
        const meta = typeof creationTx.gatewayResponse === 'string'
          ? JSON.parse(creationTx.gatewayResponse)
          : creationTx.gatewayResponse;
        if (meta?.printJobId && db.printJob && typeof db.printJob.findUnique === 'function') {
          const byId = await db.printJob.findUnique({
            where: { id: meta.printJobId },
            include: { document: true, machine: true }
          });
          if (byId) return byId;
        }
        if (meta?.jobShortId && db.printJob && typeof db.printJob.findUnique === 'function') {
          const byShort = await db.printJob.findUnique({
            where: { shortId: meta.jobShortId },
            include: { document: true, machine: true }
          });
          if (byShort) return byShort;
        }
      } catch {
        // Ignore non-JSON gatewayResponse
      }
    }
  }

  // Fallback 2: Deterministically parse shortId from order_<shortId>_<timestamp> or order_<shortId>_att<num>
  if (payment.gatewayOrderId && db.printJob && typeof db.printJob.findUnique === 'function') {
    const match = payment.gatewayOrderId.match(/^(?:demo_)?order_([^_]+)_(?:att\d+|\d+)$/);
    if (match?.[1]) {
      const byShortId = await db.printJob.findUnique({
        where: { shortId: match[1] },
        include: { document: true, machine: true }
      });
      if (byShortId) return byShortId;
    }
  }

  return null;
};

/**
 * Finds any other SUCCESS payment linked to the same PrintJob across retries.
 */
const findSuccessfulPaymentForJob = async (db, job, excludePaymentId = null) => {
  if (!job || !db.payment || typeof db.payment.findFirst !== 'function') return null;

  const orConditions = [
    { gatewayOrderId: { startsWith: `order_${job.shortId}_` } },
    { gatewayOrderId: { startsWith: `demo_order_${job.shortId}_` } }
  ];
  if (job.paymentId) {
    orConditions.unshift({ id: job.paymentId });
  }

  const where = {
    status: 'SUCCESS',
    OR: orConditions
  };
  if (excludePaymentId) {
    where.id = { not: excludePaymentId };
  }

  return db.payment.findFirst({ where });
};

const cashfreeGateway = require('../../services/cashfreeGateway.adapter');
const crypto = require('crypto');

const CASHFREE_ORDER_TTL_MS = 15 * 60 * 1000; // 15-minute validity window for pending gateway order reuse
const ORDER_LEASE_TIMEOUT_MS = 30 * 1000;    // 30-second in-flight order attempt lease

/**
 * Creates a Cashfree payment order for a pending print job.
 * Enforces server-side authoritative pricing, validates returnUrl, serializes concurrent
 * requests via short-transaction PostgreSQL advisory locks, safely reuses active pending
 * orders, and reconciles stale attempts with the gateway without holding connections during I/O.
 */
const createOrder = async (jobId, options = {}) => {
  const { sessionId, returnUrl: clientReturnUrl, ipAddress, customerPhone: overridePhone, customerEmail: overrideEmail } = options;

  // Validate Cashfree configuration first
  const config = getCashfreeConfig();
  if (!config.validation.isValid) {
    logger.warn(`Cashfree order creation rejected: ${config.validation.reason}`);
    throw new AppError(config.validation.reason, 400);
  }

  // Strictly validate client returnUrl against whitelisted frontend origins
  const validatedReturnUrl = validateReturnUrl(clientReturnUrl);

  const initialJob = await prisma.printJob.findUnique({
    where: { shortId: jobId },
    include: {
      payment: true,
      customer: true,
      machine: {
        include: {
          printerStatuses: {
            take: 1,
            orderBy: { timestamp: 'desc' }
          }
        }
      }
    }
  });

  if (!initialJob) throw new AppError('Job not found', 404);
  if (initialJob.status !== 'PENDING_PAYMENT') {
    throw new AppError(`Job cannot be paid. Current status: ${initialJob.status}`, 400);
  }

  // Cash at counter guard: online checkout is not allowed for cash orders
  if (initialJob.paymentMode === 'CASH_AT_COUNTER') {
    throw new AppError('Job is configured for Cash at Counter payment. Online checkout is not enabled.', 400);
  }

  // Authoritative Hardware Availability Guard: Never accept payment for an unserviceable job
  if (!initialJob.machineId || !initialJob.machine) {
    throw new AppError('Job is not assigned to a registered printer', 400);
  }

  const availability = computePrinterAvailability(initialJob.machine, initialJob.machine.printerStatuses?.[0] || null);
  if (!availability.isReady || availability.status !== 'ONLINE') {
    logger.warn(`Rejected payment order creation for job ${initialJob.shortId}: Printer '${initialJob.machine.name}' is ${availability.status} (${availability.statusMessage})`);
    throw new AppError(
      `Printer is currently unavailable (${availability.statusMessage}). Cannot accept payment until printer is online.`,
      409
    );
  }

  // A4: Guard against creating orders if payment already succeeded
  const existingSuccess = await findSuccessfulPaymentForJob(prisma, initialJob);
  if (existingSuccess) {
    throw new AppError('A successful payment already exists for this job', 409);
  }

  let targetReturnUrl = validatedReturnUrl;
  if (!targetReturnUrl) {
    const frontendBase = getPublicAppUrl() || (process.env.NODE_ENV !== 'production' ? 'http://localhost:5173' : null);
    if (!frontendBase) {
      throw new AppError('Payment return URL configuration (PUBLIC_APP_URL or FRONTEND_URL) is missing', 500);
    }
    targetReturnUrl = sessionId
      ? `${frontendBase}/m/${sessionId}?order_id={order_id}&job_id=${initialJob.shortId}`
      : `${frontendBase}/?order_id={order_id}&job_id=${initialJob.shortId}`;
  }

  // Generate lease token for this worker
  const currentLeaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + ORDER_LEASE_TIMEOUT_MS);

  // --------------------------------------------------------------------------
  // SHORT DB TRANSACTION 1: Serialization, Existing Order Inspection & Lease Acquisition
  // --------------------------------------------------------------------------
  const setupResult = await prisma.$transaction(async (tx) => {
    // 1. Transaction-level advisory lock serializes order creation for this job
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        `printjob_create_order_${initialJob.id}`
      );
    }

    // Re-verify authoritative job status inside lock
    const job = await tx.printJob.findUnique({
      where: { id: initialJob.id },
      include: { customer: true, payment: true }
    });

    if (!job || job.status !== 'PENDING_PAYMENT') {
      throw new AppError(`Job cannot be paid. Current status: ${job?.status || 'NOT_FOUND'}`, 400);
    }

    const currentSuccess = await findSuccessfulPaymentForJob(tx, job);
    if (currentSuccess) {
      throw new AppError('A successful payment already exists for this job', 409);
    }

    // Find any existing PENDING payment for this job across attempts
    const existingPayments = await tx.payment.findMany({
      where: {
        status: 'PENDING',
        OR: [
          { gatewayOrderId: { startsWith: `order_${job.shortId}_` } },
          { id: job.paymentId || 'none' }
        ]
      },
      orderBy: { createdAt: 'desc' }
    });

    const activeAttempt = existingPayments[0];

    if (activeAttempt) {
      // Find audit transaction to check in-flight lease
      const latestTx = await tx.transaction.findFirst({
        where: { paymentId: activeAttempt.id, action: 'ORDER_CREATION_ATTEMPT' },
        orderBy: { createdAt: 'desc' }
      });

      let leaseMeta = {};
      try {
        leaseMeta = JSON.parse(latestTx?.gatewayResponse || '{}');
      } catch {}

      const hasSessionId = Boolean(activeAttempt.gatewaySessionId);
      const isLeaseActive = leaseMeta.leaseExpiresAt && new Date(leaseMeta.leaseExpiresAt) > new Date();

      if (hasSessionId) {
        // Ready active session exists
        const ageMs = Date.now() - new Date(activeAttempt.createdAt).getTime();
        return {
          action: 'REUSE_CHECK',
          job,
          payment: activeAttempt,
          auditTx: latestTx,
          ageMs,
          gatewayOrderId: activeAttempt.gatewayOrderId,
          gatewaySessionId: activeAttempt.gatewaySessionId
        };
      } else if (isLeaseActive) {
        // Another worker is actively creating this order right now (< 30s)
        return {
          action: 'IN_FLIGHT_WAIT',
          job,
          payment: activeAttempt,
          gatewayOrderId: activeAttempt.gatewayOrderId
        };
      } else {
        // In-flight attempt without session ID whose lease expired (Worker crash recovery)
        // Refresh lease for this worker so we own the recovery
        await tx.transaction.update({
          where: { id: latestTx.id },
          data: {
            gatewayResponse: JSON.stringify({
              ...leaseMeta,
              leaseToken: currentLeaseToken,
              leaseExpiresAt: leaseExpiresAt.toISOString(),
              recoveredBy: process.pid
            })
          }
        });

        return {
          action: 'CRASH_RECOVERY',
          job,
          payment: activeAttempt,
          auditTx: latestTx,
          gatewayOrderId: activeAttempt.gatewayOrderId,
          leaseToken: currentLeaseToken
        };
      }
    }

    // No existing pending payment: calculate next deterministic attempt number
    const allAttemptsCount = await tx.payment.count({
      where: {
        OR: [
          { gatewayOrderId: { startsWith: `order_${job.shortId}_` } },
          { id: job.paymentId || 'none' }
        ]
      }
    });

    const attemptNumber = allAttemptsCount + 1;
    const uniqueOrderId = `order_${job.shortId}_att${attemptNumber}`;

    const customer = await persistCustomerForJob(tx, job, {
      overridePhone,
      overrideEmail,
      isSandbox: !config.validation.isProduction
    });

    const newPayment = await tx.payment.create({
      data: {
        amount: job.cost,
        currency: 'INR',
        status: 'PENDING',
        type: 'PRINT_JOB',
        gatewayOrderId: uniqueOrderId
      }
    });

    const updatedJob = await tx.printJob.update({
      where: { id: job.id },
      data: {
        paymentId: newPayment.id,
        customerId: customer?.id ?? job.customerId ?? null
      },
      include: { customer: true, payment: true }
    });

    const newAuditTx = await tx.transaction.create({
      data: {
        paymentId: newPayment.id,
        action: 'ORDER_CREATION_ATTEMPT',
        status: 'PENDING',
        amount: job.cost,
        ipAddress: ipAddress || null,
        gatewayResponse: JSON.stringify({
          printJobId: job.id,
          jobShortId: job.shortId,
          machineId: job.machineId || null,
          gatewayOrderId: uniqueOrderId,
          leaseToken: currentLeaseToken,
          leaseExpiresAt: leaseExpiresAt.toISOString(),
          attemptNumber
        })
      }
    });

    return {
      action: 'CREATE_NEW',
      job: updatedJob,
      payment: newPayment,
      auditTx: newAuditTx,
      gatewayOrderId: uniqueOrderId,
      leaseToken: currentLeaseToken
    };
  });

  const { job } = setupResult;

  // --------------------------------------------------------------------------
  // BRANCH 1: IN_FLIGHT_WAIT (Another worker is currently calling Cashfree)
  // --------------------------------------------------------------------------
  if (setupResult.action === 'IN_FLIGHT_WAIT') {
    // Wait briefly for the peer worker to complete session persistence
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const poll = await prisma.payment.findUnique({
        where: { id: setupResult.payment.id }
      });
      if (poll?.gatewaySessionId) {
        return {
          paymentSessionId: poll.gatewaySessionId,
          orderId: poll.gatewayOrderId,
          environment: config.validation.environment
        };
      }
    }
    // If still pending, advise client to retry without creating duplicate order
    throw new AppError('Payment initialization in progress. Please retry in a few seconds.', 429);
  }

  // --------------------------------------------------------------------------
  // BRANCH 2: REUSE_CHECK (A1: Reuse active session or A2: Reconcile stale session)
  // --------------------------------------------------------------------------
  if (setupResult.action === 'REUSE_CHECK') {
    const { ageMs, gatewayOrderId, gatewaySessionId, payment } = setupResult;

    // A1: If younger than TTL, reuse immediately without network roundtrip
    if (ageMs < CASHFREE_ORDER_TTL_MS && gatewaySessionId) {
      logger.info(`Reusing active Cashfree order ${gatewayOrderId} for job ${job.shortId} (age: ${Math.round(ageMs / 1000)}s)`);
      return {
        paymentSessionId: gatewaySessionId,
        orderId: gatewayOrderId,
        environment: config.validation.environment
      };
    }

    // A2: If older than TTL, verify with gateway before reusing or invalidating
    logger.info(`Reconciling stale Cashfree order ${gatewayOrderId} with gateway...`);
    const gatewayStatus = await cashfreeGateway.getOrderDetails(gatewayOrderId);

    if (gatewayStatus.success) {
      if (gatewayStatus.order_status === 'ACTIVE' && gatewayStatus.payment_session_id) {
        return {
          paymentSessionId: gatewayStatus.payment_session_id,
          orderId: gatewayOrderId,
          environment: config.validation.environment
        };
      }

      if (gatewayStatus.order_status === 'PAID') {
        // Customer paid! Reuse authoritative payment verification
        logger.info(`Stale order ${gatewayOrderId} is already PAID at gateway. Authoritatively capturing payment...`);
        await verifyPayment(gatewayOrderId, { source: 'ORDER_REUSE_RECONCILIATION', ipAddress });
        throw new AppError('A successful payment already exists for this job', 409);
      }

      if (gatewayStatus.order_status === 'EXPIRED' || gatewayStatus.order_status === 'TERMINATED') {
        // Order is definitively dead at gateway: mark local payment FAILED
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED' }
        });
        logger.info(`Stale order ${gatewayOrderId} confirmed EXPIRED at gateway. Re-invoking createOrder for fresh attempt.`);
        return createOrder(jobId, options);
      }
    }

    // If gateway check fails ambiguously, reuse cached session if available or fail closed
    if (gatewaySessionId) {
      return {
        paymentSessionId: gatewaySessionId,
        orderId: gatewayOrderId,
        environment: config.validation.environment
      };
    }
    throw new AppError('Unable to verify existing payment order with gateway. Please retry.', 502);
  }

  // --------------------------------------------------------------------------
  // BRANCH 3: CRASH_RECOVERY (Worker 1 died before persisting gatewaySessionId)
  // --------------------------------------------------------------------------
  if (setupResult.action === 'CRASH_RECOVERY') {
    const { gatewayOrderId, payment, auditTx, leaseToken } = setupResult;
    logger.warn(`Recovering crashed order creation attempt for ${gatewayOrderId}...`);

    const gatewayStatus = await cashfreeGateway.getOrderDetails(gatewayOrderId);

    if (gatewayStatus.success && gatewayStatus.order_status === 'ACTIVE' && gatewayStatus.payment_session_id) {
      // Recovered successfully from gateway! Save session conditionally verifying lease token
      await prisma.$transaction(async (tx) => {
        const currentAudit = await tx.transaction.findUnique({ where: { id: auditTx.id } });
        let currentMeta = {};
        try { currentMeta = JSON.parse(currentAudit?.gatewayResponse || '{}'); } catch {}

        if (currentMeta.leaseToken && currentMeta.leaseToken !== leaseToken) {
          logger.warn(`Crash recovery lease token mismatch: ${leaseToken} vs ${currentMeta.leaseToken}. Aborting.`);
          return;
        }

        await tx.payment.update({
          where: { id: payment.id },
          data: { gatewaySessionId: gatewayStatus.payment_session_id }
        });
        await tx.transaction.update({
          where: { id: auditTx.id },
          data: { status: 'SUCCESS' }
        });
      });

      return {
        paymentSessionId: gatewayStatus.payment_session_id,
        orderId: gatewayOrderId,
        environment: config.validation.environment
      };
    }

    if (gatewayStatus.success && gatewayStatus.order_status === 'PAID') {
      await verifyPayment(gatewayOrderId, { source: 'ORDER_CRASH_RECOVERY', ipAddress });
      throw new AppError('A successful payment already exists for this job', 409);
    }

    if (gatewayStatus.isNotFound) {
      // Order never reached Cashfree. Safe to mark old attempt FAILED and create fresh one
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED' }
        });
        await tx.transaction.update({
          where: { id: auditTx.id },
          data: { status: 'FAILED', errorMessage: 'Crash recovery: order never reached gateway' }
        });
      });
      return createOrder(jobId, options);
    }

    // Ambiguous gateway response during crash recovery: fail closed safely
    throw new AppError('Payment gateway status is currently ambiguous. Please retry.', 504);
  }

  // --------------------------------------------------------------------------
  // BRANCH 4: CREATE_NEW (Network I/O Outside Database Transaction)
  // --------------------------------------------------------------------------
  const { payment, auditTx, gatewayOrderId, leaseToken } = setupResult;

  const isSandbox = !config.validation.isProduction;
  const customerDetails = resolveCustomerDetails(job, { isSandbox });

  const payload = {
    order_id: gatewayOrderId,
    order_amount: job.cost,
    order_currency: 'INR',
    customer_details: customerDetails,
    order_meta: {
      return_url: targetReturnUrl,
      ...(config.notifyUrl ? { notify_url: config.notifyUrl } : {})
    },
    order_note: `PrintGo Self-Service Kiosk Job ${job.shortId}`
  };

  logger.info(`Creating Cashfree order ${gatewayOrderId} for job ${job.shortId} (amount: ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹${job.cost})`);

  let response;
  try {
    response = await axios.post(config.orderUrl, payload, {
      headers: config.headers,
      timeout: config.timeout
    });
  } catch (error) {
    const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
    logger.warn(`Cashfree order creation error for ${gatewayOrderId} (timeout=${isTimeout}):`, error.message);

    // If ambiguous timeout or 5xx, attempt reconciliation using the exact same orderId
    if (isTimeout || (error?.response?.status && error.response.status >= 500)) {
      const reconciled = await cashfreeGateway.getOrderDetails(gatewayOrderId);
      if (reconciled.success && reconciled.order_status === 'ACTIVE' && reconciled.payment_session_id) {
        response = { data: reconciled.rawResponse || { payment_session_id: reconciled.payment_session_id, order_id: gatewayOrderId } };
      }
    }

    // If still unresolved, mark FAILED and throw
    if (!response) {
      await prisma.$transaction(async (tx) => {
        await tx.payment.updateMany({
          where: { id: payment.id, status: 'PENDING' },
          data: { status: 'FAILED' }
        }).catch(() => {});

        await tx.transaction.update({
          where: { id: auditTx.id },
          data: {
            status: 'FAILED',
            errorCode: String(error?.response?.status || '500'),
            errorMessage: String(error?.response?.data?.message || error.message)
          }
        }).catch(() => {});
      });

      throw new AppError(`Failed to create Cashfree payment order: ${error?.response?.data?.message || error.message}`, 502);
    }
  }

  const returnedOrderId = response.data.order_id || gatewayOrderId;
  const paymentSessionId = response.data.payment_session_id;

  // --------------------------------------------------------------------------
  // SHORT DB TRANSACTION 2: Commit Gateway References with Lease Verification
  // --------------------------------------------------------------------------
  const commitResult = await prisma.$transaction(async (tx) => {
    // 1. Atomically verify lease ownership inside transaction
    const latestAuditTx = await tx.transaction.findUnique({
      where: { id: auditTx.id }
    });

    let currentLeaseMeta = {};
    try {
      currentLeaseMeta = JSON.parse(latestAuditTx?.gatewayResponse || '{}');
    } catch {}

    // Check if another worker took over our lease
    if (currentLeaseMeta.leaseToken && currentLeaseMeta.leaseToken !== leaseToken) {
      logger.warn(
        `Lease lost for order ${gatewayOrderId}: worker lease '${leaseToken}' replaced by '${currentLeaseMeta.leaseToken}'. Rejecting stale persistence.`
      );
      // Fetch latest payment state to see if the newer worker succeeded
      const currentPayment = await tx.payment.findUnique({
        where: { id: payment.id }
      });
      return {
        leaseLost: true,
        currentPayment
      };
    }

    // 2. Ownership verified: proceed with atomic update
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        gatewayOrderId: returnedOrderId,
        gatewaySessionId: paymentSessionId
      }
    });

    const redactedGateway = (() => {
      try {
        return JSON.parse(redactSensitiveData(response.data) || '{}');
      } catch {
        return {};
      }
    })();

    await tx.transaction.update({
      where: { id: auditTx.id },
      data: {
        status: 'SUCCESS',
        gatewayResponse: JSON.stringify({
          printJobId: job.id,
          jobShortId: job.shortId,
          machineId: job.machineId || null,
          leaseToken,
          ...redactedGateway
        })
      }
    });

    return {
      leaseLost: false,
      paymentSessionId,
      orderId: returnedOrderId
    };
  });

  if (commitResult.leaseLost) {
    // If the newer worker already persisted a session, return that authoritative session
    if (commitResult.currentPayment?.gatewaySessionId) {
      logger.info(`Stale worker yielding to newer worker's active session for order ${gatewayOrderId}`);
      return {
        paymentSessionId: commitResult.currentPayment.gatewaySessionId,
        orderId: commitResult.currentPayment.gatewayOrderId,
        environment: config.validation.environment
      };
    }
    // Otherwise fail closed and advise client to retry/reconcile
    throw new AppError('Payment attempt lease expired and was reassigned. Please retry.', 409);
  }

  return {
    paymentSessionId,
    orderId: returnedOrderId,
    environment: config.validation.environment
  };
};

/**
 * Server-side payment verification via Cashfree APIs.
 * Compares authoritative amount, resolves the linked PrintJob across payment retries,
 * enforces job-level advisory locking to prevent duplicate printing, and flags
 * duplicate successful payments in ReconciliationRecord.
 */
const verifyPayment = async (orderId, metadata = {}) => {
  const payment = await prisma.payment.findUnique({
    where: { gatewayOrderId: orderId },
    include: { printJobs: true }
  });

  if (!payment) throw new AppError('Payment not found', 404);

  // Already processed ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â idempotent return using resilient resolver
  if (payment.status === 'SUCCESS') {
    const job = await resolvePrintJobForPayment(prisma, payment);
    return { updatedJob: job, wasJustUpdated: false, status: 'SUCCESS' };
  }

  // Validate state machine transition
  if (!isValidPaymentTransition(payment.status, 'SUCCESS')) {
    logger.warn(`Payment ${orderId}: transition from ${payment.status} to SUCCESS not permitted by state machine`);
    return { updatedJob: null, wasJustUpdated: false, status: payment.status };
  }

  const config = getCashfreeConfig();
  if (!config.validation.isValid) {
    throw new AppError(`Cannot verify payment via gateway: ${config.validation.reason}`, 400);
  }

  try {
    // 1. Fetch order details from Cashfree
    const orderRes = await axios.get(`${config.orderUrl}/${orderId}`, {
      headers: config.headers,
      timeout: config.timeout
    });

    const orderData = orderRes.data;

    if (orderData.order_status === 'PAID') {
      // 2. Strict amount verification
      const paidAmount = Number(orderData.order_amount);
      const expectedAmount = Number(payment.amount);
      if (Math.abs(paidAmount - expectedAmount) > 0.01) {
        logger.error(`CRITICAL: Payment amount mismatch for order ${orderId}! Expected: ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹${expectedAmount}, Received: ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹${paidAmount}`);

        await prisma.transaction.create({
          data: {
            paymentId: payment.id,
            action: 'AMOUNT_MISMATCH_DETECTED',
            status: 'FAILED',
            amount: paidAmount,
            errorMessage: `Amount mismatch. Expected ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹${expectedAmount}, got ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹${paidAmount}`,
            gatewayResponse: redactSensitiveData(orderData)
          }
        });

        throw new AppError('Payment amount mismatch between gateway and database', 400);
      }

      // 3. Optionally fetch payment details (method, cf_payment_id)
      let cfPaymentId = null;
      let paymentMethod = null;
      let paymentGroup = null;

      try {
        const paymentsRes = await axios.get(`${config.orderUrl}/${orderId}/payments`, {
          headers: config.headers,
          timeout: config.timeout
        });
        if (Array.isArray(paymentsRes.data) && paymentsRes.data.length > 0) {
          const successfulPayment = paymentsRes.data.find(p => p.payment_status === 'SUCCESS') || paymentsRes.data[0];
          cfPaymentId = successfulPayment.cf_payment_id ? String(successfulPayment.cf_payment_id) : null;
          paymentMethod = successfulPayment.payment_method ? JSON.stringify(successfulPayment.payment_method) : null;
          paymentGroup = successfulPayment.payment_group || null;
        }
      } catch (e) {
        logger.warn(`Could not fetch payment methods for order ${orderId}: ${e.message}`);
      }

      // 4. Atomically update payment & claim PrintJob print transition inside job-level advisory lock
      const result = await prisma.$transaction(async (tx) => {
        const resolvedJobBeforeLock = await resolvePrintJobForPayment(tx, payment);

        if (resolvedJobBeforeLock?.id && typeof tx.$executeRawUnsafe === 'function') {
          await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            `printjob_pay_${resolvedJobBeforeLock.id}`
          );
        }

        // Atomic conditional update: guarantees only ONE concurrent worker transitions payment PENDING -> SUCCESS
        const updateResult = typeof tx.payment.updateMany === 'function'
          ? await tx.payment.updateMany({
              where: { id: payment.id, status: 'PENDING' },
              data: {
                status: 'SUCCESS',
                gatewayPaymentId: cfPaymentId,
                paymentMethod: paymentMethod,
                paymentGroup: paymentGroup,
                paidAt: new Date()
              }
            })
          : await tx.payment.update({
              where: { id: payment.id },
              data: { status: 'SUCCESS', paidAt: new Date() }
            }).then(() => ({ count: 1 }));

        const updatedCount = updateResult?.count !== undefined ? updateResult.count : 1;
        if (updatedCount === 0) {
          const job = await resolvePrintJobForPayment(tx, payment);
          return { updatedJob: job, wasJustUpdated: false, status: 'SUCCESS' };
        }

        // Record audit transaction
        if (tx.transaction && typeof tx.transaction.create === 'function') {
          await tx.transaction.create({
            data: {
              paymentId: payment.id,
              action: metadata.source === 'WEBHOOK' ? 'WEBHOOK_PAYMENT_SUCCESS' : 'VERIFICATION_POLL_SUCCESS',
              status: 'SUCCESS',
              amount: paidAmount,
              gatewayPaymentId: cfPaymentId,
              ipAddress: metadata.ipAddress || null,
              gatewayResponse: redactSensitiveData(orderData)
            }
          });
        }

        // Re-fetch authoritative job state inside advisory lock
        const job = resolvedJobBeforeLock?.id && typeof tx.printJob.findUnique === 'function'
          ? await tx.printJob.findUnique({
              where: { id: resolvedJobBeforeLock.id },
              include: { document: true, machine: true }
            })
          : resolvedJobBeforeLock;

        if (!job) {
          logger.error(`CRITICAL: Successful payment ${payment.id} (${orderId}) could not be resolved to any PrintJob`);
          if (tx.reconciliationRecord && typeof tx.reconciliationRecord.create === 'function') {
            await tx.reconciliationRecord.create({
              data: {
                paymentId: payment.id,
                status: 'MANUAL_REVIEW_REQUIRED',
                discrepancyType: 'ORPHANED_SUCCESSFUL_PAYMENT',
                details: JSON.stringify({
                  gatewayOrderId: orderId,
                  gatewayPaymentId: cfPaymentId,
                  gatewayStatus: 'PAID',
                  internalStatus: 'NO_JOB_FOUND',
                  gatewayAmount: paidAmount,
                  internalAmount: expectedAmount
                })
              }
            }).catch((err) => logger.error('Failed to record orphaned payment discrepancy:', err.message));
          }
          return { updatedJob: null, wasJustUpdated: false, status: 'SUCCESS' };
        }

        // Check whether another Payment for this job already succeeded
        const priorSuccessPayment = await findSuccessfulPaymentForJob(tx, job, payment.id);

        if (!priorSuccessPayment && job.status === 'PENDING_PAYMENT' && isValidJobTransition(job.status, 'WAITING')) {
          const updatedJob = await tx.printJob.update({
            where: { id: job.id },
            data: {
              status: 'WAITING',
              paymentId: payment.id // Point job to the winning paid payment
            },
            include: { document: true, machine: true }
          });
          return { updatedJob, wasJustUpdated: true, status: 'SUCCESS' };
        }

        // Duplicate successful payment OR payment captured for non-PENDING_PAYMENT job:
        // NEVER trigger a second print. Log immutable discrepancy & alert reconciliation!
        const discrepancyType = priorSuccessPayment
          ? 'DUPLICATE_PAYMENT_FOR_JOB'
          : 'LATE_PAYMENT_ON_NON_PENDING_JOB';

        logger.error(
          `CRITICAL: ${discrepancyType} detected for job ${job.shortId}! ` +
          `Primary payment: ${priorSuccessPayment?.id || job.paymentId}, secondary order: ${orderId} (ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¹${paidAmount}). Suppressing duplicate print.`
        );

        if (tx.transaction && typeof tx.transaction.create === 'function') {
          await tx.transaction.create({
            data: {
              paymentId: payment.id,
              action: discrepancyType,
              status: 'SUCCESS',
              amount: paidAmount,
              gatewayPaymentId: cfPaymentId,
              ipAddress: metadata.ipAddress || null,
              errorMessage: `${discrepancyType} on job ${job.shortId} (job status: ${job.status})`,
              gatewayResponse: redactSensitiveData({
                printJobId: job.id,
                shortId: job.shortId,
                primaryPaymentId: priorSuccessPayment?.id || job.paymentId,
                duplicatePaymentId: payment.id,
                gatewayOrderId: orderId
              })
            }
          });
        }

        if (tx.reconciliationRecord && typeof tx.reconciliationRecord.create === 'function') {
          await tx.reconciliationRecord.create({
            data: {
              paymentId: payment.id,
              printJobId: job.id,
              status: 'MANUAL_REVIEW_REQUIRED',
              discrepancyType,
              details: JSON.stringify({
                printJobId: job.id,
                shortId: job.shortId,
                primaryPaymentId: priorSuccessPayment?.id || job.paymentId,
                duplicatePaymentId: payment.id,
                gatewayOrderId: orderId,
                gatewayPaymentId: cfPaymentId,
                gatewayStatus: 'PAID',
                internalStatus: job.status,
                gatewayAmount: paidAmount,
                internalAmount: job.cost
              })
            }
          });
        }

        return { updatedJob: job, wasJustUpdated: false, duplicateDetected: true, status: 'SUCCESS' };
      });

      return result;
    } else if (orderData.order_status === 'EXPIRED' || orderData.order_status === 'TERMINATED') {
      // Guarded update: only transition PENDING -> FAILED; never overwrite SUCCESS
      const failUpdate = await prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED' }
      }).catch(() => ({ count: 0 }));

      if (failUpdate.count > 0) {
        await prisma.transaction.create({
          data: {
            paymentId: payment.id,
            action: 'PAYMENT_FAILED',
            status: 'FAILED',
            gatewayResponse: redactSensitiveData(orderData)
          }
        }).catch(() => {});
      }

      return { updatedJob: null, wasJustUpdated: false, status: orderData.order_status };
    }

    return { updatedJob: null, wasJustUpdated: false, status: orderData.order_status };
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Payment verification error:', error?.response?.data || error.message);
    throw new AppError('Failed to verify payment with gateway', 502);
  }
};

/**
 * Unified job-level refund entrypoint delegating to refund.service.js
 * (advisory locking, idempotency, Credit Note issuance, duplicate prevention).
 */
const refundPayment = async (jobId, user = null, refundReason = 'PrintGo Customer Requested Refund', options = {}) => {
  const job = await prisma.printJob.findUnique({
    where: { shortId: jobId },
    include: { payment: true, machine: true }
  });

  if (!job) throw new AppError('Job not found', 404);

  // Multi-tenancy check
  if (user && user.role !== 'SUPERADMIN') {
    if (!job.machine || job.machine.companyId !== user.companyId) {
      throw new AppError('Access denied: Cannot refund jobs belonging to another company', 403);
    }
  }

  if (!job.payment) throw new AppError('No payment record found for this job', 400);

  if (job.status === 'COMPLETED') {
    throw new AppError('Completed jobs cannot be refunded through the failure workflow as physical printing was already fulfilled.', 400);
  }

  if (job.status === 'PRINTING') {
    throw new AppError('Cannot refund a job currently in PRINTING status. Resolve the physical print outcome first.', 400);
  }

  const refundRecord = await refundService.createRefund({
    paymentId: job.payment.id,
    amount: options.amount,
    reason: refundReason,
    idempotencyKey: options.idempotencyKey || `job_refund_${job.id}_${job.payment.id}`,
    user,
    initiatedBy: user?.id || options.initiatedBy || 'ADMIN'
  });

  if (refundRecord.status === 'FAILED') {
    throw new AppError(refundRecord.failureReason || 'Failed to process refund with payment gateway', 502);
  }

  const updatedPayment = await prisma.payment.findUnique({
    where: { id: job.payment.id }
  });

  if (!options.preserveJobStatus && updatedPayment?.status === 'REFUNDED' && job.status !== 'CANCELLED') {
    const updatedJob = await prisma.printJob.update({
      where: { id: job.id },
      data: { status: 'CANCELLED' },
      include: { payment: true, machine: true, document: true }
    });
    return { ...updatedJob, refund: refundRecord };
  }

  return { ...job, payment: updatedPayment || job.payment, refund: refundRecord };
};

module.exports = {
  createOrder,
  verifyPayment,
  refundPayment,
  resolvePrintJobForPayment,
  findSuccessfulPaymentForJob
};
