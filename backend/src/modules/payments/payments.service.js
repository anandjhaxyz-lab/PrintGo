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

  // Fallback 2: Deterministically parse shortId from order_<shortId>_<timestamp>
  if (payment.gatewayOrderId && db.printJob && typeof db.printJob.findUnique === 'function') {
    const match = payment.gatewayOrderId.match(/^(?:demo_)?order_([^_]+)_\d+$/);
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

/**
 * Creates a Cashfree payment order for a pending print job.
 * Enforces server-side authoritative pricing, validates returnUrl, preserves
 * multi-attempt payment history, and records immutable Transaction audit metadata.
 */
const createOrder = async (jobId, options = {}) => {
  const { sessionId, returnUrl: clientReturnUrl, ipAddress } = options;

  // Validate Cashfree configuration first
  const config = getCashfreeConfig();
  if (!config.validation.isValid) {
    logger.warn(`Cashfree order creation rejected: ${config.validation.reason}`);
    throw new AppError(config.validation.reason, 400);
  }

  // Strictly validate client returnUrl against whitelisted frontend origins
  const validatedReturnUrl = validateReturnUrl(clientReturnUrl);

  const job = await prisma.printJob.findUnique({
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

  if (!job) throw new AppError('Job not found', 404);
  if (job.status !== 'PENDING_PAYMENT') {
    throw new AppError(`Job cannot be paid. Current status: ${job.status}`, 400);
  }

  // Cash at counter guard: online checkout is not allowed for cash orders
  if (job.paymentMode === 'CASH_AT_COUNTER') {
    throw new AppError('Job is configured for Cash at Counter payment. Online checkout is not enabled.', 400);
  }

  // Authoritative Hardware Availability Guard: Never accept payment for an unserviceable job
  if (!job.machineId || !job.machine) {
    throw new AppError('Job is not assigned to a registered printer', 400);
  }

  const availability = computePrinterAvailability(job.machine, job.machine.printerStatuses?.[0] || null);
  if (!availability.isReady || availability.status !== 'ONLINE') {
    logger.warn(`Rejected payment order creation for job ${job.shortId}: Printer '${job.machine.name}' is ${availability.status} (${availability.statusMessage})`);
    throw new AppError(
      `Printer is currently unavailable (${availability.statusMessage}). Cannot accept payment until printer is online.`,
      409
    );
  }

  // Block creating a duplicate payment order if any payment for this job already succeeded
  const existingSuccess = await findSuccessfulPaymentForJob(prisma, job);
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
      ? `${frontendBase}/m/${sessionId}?order_id={order_id}&job_id=${job.shortId}`
      : `${frontendBase}/?order_id={order_id}&job_id=${job.shortId}`;
  }

  const uniqueOrderId = `order_${job.shortId}_${Date.now()}`;

  // 1. Create local Payment record (PENDING) + immutable linkage metadata atomically
  const { payment, auditTx } = await prisma.$transaction(async (tx) => {
    const newPayment = await tx.payment.create({
      data: {
        amount: job.cost,
        currency: 'INR',
        status: 'PENDING',
        type: 'PRINT_JOB',
        gatewayOrderId: uniqueOrderId
      }
    });

    // Update job.paymentId to point at latest PENDING attempt only if not already linked to a SUCCESS payment
    if (!job.payment || job.payment.status !== 'SUCCESS') {
      await tx.printJob.update({
        where: { id: job.id },
        data: { paymentId: newPayment.id }
      });
    }

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
          gatewayOrderId: uniqueOrderId
        })
      }
    });

    return { payment: newPayment, auditTx: newAuditTx };
  });

  const customerId = job.customer?.id || `cust_${job.shortId}`;
  const customerPhone = job.customer?.phone || '9999999999';
  const customerName = job.customer?.name || 'PrintGo Customer';
  const customerEmail = job.customer?.email || `kiosk_${job.shortId}@printgo.local`;

  try {
    const payload = {
      order_id: uniqueOrderId,
      order_amount: job.cost,
      order_currency: 'INR',
      customer_details: {
        customer_id: customerId,
        customer_phone: customerPhone,
        customer_name: customerName,
        customer_email: customerEmail
      },
      order_meta: {
        return_url: targetReturnUrl,
        ...(config.notifyUrl ? { notify_url: config.notifyUrl } : {})
      },
      order_note: `PrintGo Self-Service Kiosk Job ${job.shortId}`
    };

    logger.info(`Creating Cashfree order ${uniqueOrderId} for job ${job.shortId} (amount: ₹${job.cost})`);

    const response = await axios.post(config.orderUrl, payload, {
      headers: config.headers,
      timeout: config.timeout
    });

    const returnedOrderId = response.data.order_id || uniqueOrderId;

    // 4. Update Payment with gateway references
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        gatewayOrderId: returnedOrderId,
        gatewaySessionId: response.data.payment_session_id
      }
    });

    // 5. Preserve job linkage metadata alongside redacted gateway response
    const redactedGateway = (() => {
      try {
        return JSON.parse(redactSensitiveData(response.data) || '{}');
      } catch {
        return {};
      }
    })();

    await prisma.transaction.update({
      where: { id: auditTx.id },
      data: {
        status: 'SUCCESS',
        gatewayResponse: JSON.stringify({
          printJobId: job.id,
          jobShortId: job.shortId,
          machineId: job.machineId || null,
          ...redactedGateway
        })
      }
    });

    return {
      paymentSessionId: response.data.payment_session_id,
      orderId: returnedOrderId,
      environment: config.validation.environment
    };
  } catch (error) {
    const gatewayError = error?.response?.data || error.message;
    logger.error('Cashfree order creation error:', gatewayError);

    // Mark PENDING local order as FAILED cleanly so stale attempt cannot dangle
    await prisma.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: 'FAILED' }
    }).catch(() => {});

    // Record failure in audit ledger while preserving printJobId linkage
    await prisma.transaction.update({
      where: { id: auditTx.id },
      data: {
        status: 'FAILED',
        errorCode: String(error?.response?.status || '500'),
        errorMessage: typeof gatewayError === 'object' ? JSON.stringify(gatewayError) : String(gatewayError),
        gatewayResponse: JSON.stringify({
          printJobId: job.id,
          jobShortId: job.shortId,
          error: (() => {
            try { return JSON.parse(redactSensitiveData(gatewayError) || 'null'); } catch { return String(gatewayError); }
          })()
        })
      }
    }).catch(e => logger.error('Failed to update audit transaction:', e));

    throw new AppError(`Failed to create Cashfree payment order: ${gatewayError?.message || error.message}`, 502);
  }
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

  // Already processed — idempotent return using resilient resolver
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
        logger.error(`CRITICAL: Payment amount mismatch for order ${orderId}! Expected: ₹${expectedAmount}, Received: ₹${paidAmount}`);

        await prisma.transaction.create({
          data: {
            paymentId: payment.id,
            action: 'AMOUNT_MISMATCH_DETECTED',
            status: 'FAILED',
            amount: paidAmount,
            errorMessage: `Amount mismatch. Expected ₹${expectedAmount}, got ₹${paidAmount}`,
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

        if (updateResult.count === 0) {
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
          `Primary payment: ${priorSuccessPayment?.id || job.paymentId}, secondary order: ${orderId} (₹${paidAmount}). Suppressing duplicate print.`
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

  if (!options.preserveJobStatus && updatedPayment?.status === 'REFUNDED' && job.status !== 'CANCELLED' && job.status !== 'FAILED') {
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
