const paymentsService = require('./payments.service');
const prisma = require('../../utils/prisma');
const logger = require('../../utils/logger');
const queueService = require('../../services/queueService');
const cashfreeGateway = require('../../services/cashfreeGateway.adapter');
const { issueCreditNoteForInvoice } = require('../../services/invoice.service');
const { redactSensitiveData } = require('../../config/cashfree.config');
const {
  isDemoPaymentPermitted,
  verifyDemoAccessCode,
  isDemoAccessRateLimited,
  recordDemoAccessFailure,
  clearDemoAccessFailures,
  isDemoAccessCodeRequired
} = require('../../utils/demoPaymentGuard');

/**
 * Extracts sessionId stored inside a job's pricingSnapshot JSON, if present.
 */
const extractJobSessionId = (job) => {
  if (!job?.pricingSnapshot) return null;
  try {
    const snap = typeof job.pricingSnapshot === 'string'
      ? JSON.parse(job.pricingSnapshot)
      : job.pricingSnapshot;
    return snap?.sessionId || null;
  } catch {
    return null;
  }
};

/**
 * Enforces session, machine, and multi-tenant ownership for customer/admin payment endpoints.
 * Returns null if authorized, or { status, error } when access must be denied.
 */
const checkJobAccess = (req, job) => {
  if (!job) return { status: 404, error: 'Job not found' };

  if (req.session) {
    if (req.session.machineId) {
      if (job.machineId !== req.session.machineId) {
        return { status: 403, error: 'Access denied: Session does not own this machine job' };
      }
    } else if (job.machineId !== null) {
      return { status: 403, error: 'Access denied: Machine session required for this job' };
    }

    const jobSessionId = extractJobSessionId(job);
    if (jobSessionId && req.session.sessionId && jobSessionId !== req.session.sessionId) {
      return { status: 403, error: 'Access denied: Session does not own this job' };
    }
    return null;
  }

  if (req.user) {
    if (req.user.role === 'SUPERADMIN') return null;
    if (!job.machine || job.machine.companyId !== req.user.companyId) {
      return { status: 403, error: 'Access denied: Cannot access job belonging to another company' };
    }
    return null;
  }

  return { status: 401, error: 'Authentication required' };
};

const createCashfreeOrder = async (req, res, next) => {
  try {
    const { id } = req.params; // jobId (shortId)
    const sessionId = req.session?.sessionId || req.body?.sessionId;
    const returnUrl = req.body?.returnUrl;
    const ipAddress = req.ip || req.connection?.remoteAddress;

    const job = await prisma.printJob.findUnique({
      where: { shortId: id },
      include: { machine: true }
    });

    const accessErr = checkJobAccess(req, job);
    if (accessErr) {
      return res.status(accessErr.status).json({ success: false, error: accessErr.error });
    }

    const orderDetails = await paymentsService.createOrder(id, {
      sessionId,
      returnUrl,
      ipAddress
    });

    res.json({ success: true, ...orderDetails });
  } catch (error) {
    next(error);
  }
};

const verifyPayment = async (req, res, next) => {
  try {
    const { id } = req.params; // jobId (shortId) or gatewayOrderId
    const ipAddress = req.ip || req.connection?.remoteAddress;

    let targetOrderId = null;
    let job = await prisma.printJob.findUnique({
      where: { shortId: id },
      include: { payment: true, machine: true }
    });

    if (job) {
      targetOrderId = job.payment?.gatewayOrderId || null;
    } else {
      // Check by specific Cashfree gatewayOrderId (handles earlier/retry orders too)
      const payment = await prisma.payment.findUnique({
        where: { gatewayOrderId: id },
        include: { printJobs: { include: { machine: true } } }
      });
      if (payment) {
        job = await paymentsService.resolvePrintJobForPayment(prisma, payment);
        if (job) {
          if (!job.machine && job.machineId) {
            job.machine = await prisma.machine.findUnique({ where: { id: job.machineId } });
          }
          const { printJobs: _omittedPrintJobs, ...safePayment } = payment;
          job.payment = safePayment;
          targetOrderId = payment.gatewayOrderId;
        }
      }
    }

    const accessErr = checkJobAccess(req, job);
    if (accessErr) {
      return res.status(accessErr.status).json({ success: false, error: accessErr.error });
    }

    // If a specific orderId was passed that hasn't been verified yet, verify it even if job moved past PENDING_PAYMENT
    const isSpecificOrderCheck = Boolean(targetOrderId && id === targetOrderId && job.payment?.status === 'PENDING');

    if (job.status !== 'PENDING_PAYMENT' && !isSpecificOrderCheck) {
      return res.json({ success: true, job, status: job.status });
    }

    if (!targetOrderId) {
      return res.json({
        success: false,
        status: 'NO_PAYMENT_INITIATED',
        message: 'No payment order has been initiated for this job'
      });
    }

    const { updatedJob, wasJustUpdated, status } = await paymentsService.verifyPayment(
      targetOrderId,
      { source: 'POLL', ipAddress }
    );

    if (updatedJob) {
      if (updatedJob.status === 'WAITING' && wasJustUpdated && queueService?.startPrintingProcess) {
        logger.info(`Payment confirmed via polling. Triggering print queue for job ${updatedJob.shortId}`);
        queueService.startPrintingProcess(updatedJob.shortId, req.app.get('io'));
      }
      return res.json({ success: true, job: updatedJob, status: updatedJob.status });
    }

    res.json({ success: false, status: status || 'PENDING' });
  } catch (error) {
    next(error);
  }
};

/**
 * Cashfree Webhook Handler
 * Enforces HMAC-SHA256 signature verification on raw request body (constant-time),
 * validates timestamp replay window, guarantees event-level idempotency via PaymentEvent,
 * and handles success, failure, user-dropped, and refund status events.
 */
const cashfreeWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const ipAddress = req.ip || req.connection?.remoteAddress;

    if (!signature || !timestamp) {
      logger.warn('Cashfree webhook received without required signature or timestamp headers');
      return res.status(401).send('Missing signature headers');
    }

    if (!process.env.CASHFREE_SECRET_KEY) {
      logger.error('Cashfree webhook rejected: CASHFREE_SECRET_KEY is not configured');
      return res.status(401).send('Webhook verification unavailable');
    }

    // 1. Strict timestamp replay protection (supports 10-digit sec or 13-digit ms, +/- 15 min)
    if (!/^\d+$/.test(String(timestamp))) {
      logger.warn('Cashfree webhook received with non-numeric timestamp');
      return res.status(401).send('Invalid webhook timestamp');
    }
    const parsedTs = Number(timestamp);
    if (!Number.isFinite(parsedTs) || parsedTs <= 0) {
      return res.status(401).send('Invalid webhook timestamp');
    }
    const eventSec = parsedTs > 1e12 ? Math.floor(parsedTs / 1000) : Math.floor(parsedTs);
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - eventSec) > 900) {
      logger.warn(`Webhook timestamp out of allowed 15-minute window (eventSec: ${eventSec}, nowSec: ${nowSec})`);
      return res.status(401).send('Webhook timestamp expired');
    }

    // 2. Validate raw request body + constant-time HMAC-SHA256 signature via gateway adapter
    const rawBody = typeof req.rawBody === 'string'
      ? req.rawBody
      : (Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : null);

    if (!rawBody) {
      logger.warn('Cashfree webhook rejected: rawBody buffer not available for signature check');
      return res.status(401).send('Invalid raw webhook payload');
    }

    if (!cashfreeGateway.verifyWebhookSignature(signature, rawBody, String(timestamp))) {
      logger.warn('Cashfree webhook signature mismatch — possible tampering or invalid secret key');
      return res.status(401).send('Invalid webhook signature');
    }

    const event = req.body;
    const eventType = event?.type;
    const orderData = event?.data?.order || {};
    const refundData = event?.data?.refund || {};
    const orderId = orderData.order_id || refundData.order_id;

    if (!orderId && !refundData.refund_id && !refundData.cf_refund_id) {
      logger.warn('Webhook payload contains no order_id or refund reference');
      return res.status(200).send('Ignored: missing order_id');
    }

    // 3. Webhook Idempotency Check using PaymentEvent
    const entityKey = orderId || refundData.refund_id || String(refundData.cf_refund_id);
    const uniqueEventId = event?.event_id || `${timestamp}_${entityKey}_${eventType}`;

    const existingEvent = await prisma.paymentEvent.findUnique({
      where: { eventId: uniqueEventId }
    });

    if (existingEvent && existingEvent.processed) {
      logger.info(`Webhook idempotency: Event ${uniqueEventId} already processed. Skipping duplicate.`);
      return res.status(200).send('Already processed');
    }

    const recordedEvent = existingEvent || await prisma.paymentEvent.create({
      data: {
        eventId: uniqueEventId,
        eventType: eventType || 'UNKNOWN_WEBHOOK',
        gatewayOrderId: entityKey,
        signature: signature,
        payload: redactSensitiveData(event),
        processed: false
      }
    });

    logger.info(`Processing Cashfree webhook: type=${eventType}, entity=${entityKey}`);

    // 4. Handle Event Types
    if (eventType === 'PAYMENT_SUCCESS_WEBHOOK') {
      const { updatedJob, wasJustUpdated } = await paymentsService.verifyPayment(
        orderId,
        { source: 'WEBHOOK', ipAddress }
      );

      await prisma.paymentEvent.update({
        where: { id: recordedEvent.id },
        data: { processed: true, processedAt: new Date() }
      });

      if (updatedJob && wasJustUpdated && queueService?.startPrintingProcess) {
        logger.info(`Webhook: Payment verified for job ${updatedJob.shortId}. Dispatching to print queue.`);
        queueService.startPrintingProcess(updatedJob.shortId, req.app.get('io'));
      }
    } else if (eventType === 'PAYMENT_FAILED_WEBHOOK' || eventType === 'PAYMENT_USER_DROPPED_WEBHOOK') {
      const payment = orderId
        ? await prisma.payment.findUnique({ where: { gatewayOrderId: orderId } })
        : null;

      if (payment) {
        // Conditional update: delayed failure/drop webhook MUST NEVER overwrite SUCCESS/REFUNDED
        const updated = await prisma.payment.updateMany({
          where: { id: payment.id, status: 'PENDING' },
          data: { status: 'FAILED' }
        });

        const txAction = eventType === 'PAYMENT_USER_DROPPED_WEBHOOK'
          ? 'WEBHOOK_PAYMENT_USER_DROPPED'
          : 'WEBHOOK_PAYMENT_FAILED';

        await prisma.transaction.create({
          data: {
            paymentId: payment.id,
            action: updated.count > 0 ? txAction : `IGNORED_LATE_${txAction}`,
            status: updated.count > 0 ? 'FAILED' : payment.status,
            errorMessage: updated.count > 0
              ? (event?.data?.payment?.payment_message || (eventType === 'PAYMENT_USER_DROPPED_WEBHOOK' ? 'User dropped payment' : 'Payment failed'))
              : `Ignored late ${eventType} because payment status is already ${payment.status}`,
            ipAddress: ipAddress || null,
            gatewayResponse: redactSensitiveData(event)
          }
        });
      }

      await prisma.paymentEvent.update({
        where: { id: recordedEvent.id },
        data: { processed: true, processedAt: new Date() }
      });
    } else if (eventType === 'REFUND_STATUS_WEBHOOK') {
      const gatewayRefundId = refundData.refund_id || null;
      const cfRefundId = refundData.cf_refund_id ? String(refundData.cf_refund_id) : null;
      const rawRefundStatus = String(refundData.refund_status || '').toUpperCase();

      const refundRecord = await prisma.refund.findFirst({
        where: {
          OR: [
            ...(cfRefundId ? [{ cfRefundId }] : []),
            ...(gatewayRefundId ? [{ gatewayRefundId }] : [])
          ]
        },
        include: {
          payment: {
            include: {
              printJobs: { include: { invoice: true } }
            }
          }
        }
      });

      if (refundRecord) {
        const mappedStatus = rawRefundStatus === 'SUCCESS'
          ? 'SUCCESS'
          : (rawRefundStatus === 'CANCELLED' || rawRefundStatus === 'FAILED' ? 'FAILED' : 'PROCESSING');

        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            `payment_refund_${refundRecord.paymentId}`
          );

          await tx.refund.update({
            where: { id: refundRecord.id },
            data: {
              status: mappedStatus,
              cfRefundId: cfRefundId || refundRecord.cfRefundId,
              gatewayResponse: redactSensitiveData(event),
              ...(mappedStatus === 'SUCCESS' ? { processedAt: new Date() } : {}),
              ...(mappedStatus === 'FAILED' ? { failureReason: refundData.status_description || 'Refund failed at gateway' } : {})
            }
          });

          await tx.transaction.create({
            data: {
              paymentId: refundRecord.paymentId,
              action: `WEBHOOK_REFUND_${mappedStatus}`,
              status: mappedStatus,
              amount: Number(refundData.refund_amount || refundRecord.amount),
              ipAddress: ipAddress || null,
              gatewayResponse: redactSensitiveData(event)
            }
          });

          if (mappedStatus === 'SUCCESS' && refundRecord.payment) {
            const successRefunds = await tx.refund.findMany({
              where: { paymentId: refundRecord.paymentId, status: 'SUCCESS' }
            });
            const totalRefundedCents = successRefunds.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);
            const paymentCents = Math.round(Number(refundRecord.payment.amount) * 100);
            await tx.payment.update({
              where: { id: refundRecord.paymentId },
              data: { status: totalRefundedCents >= paymentCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED' }
            });
          }
        });

        if (mappedStatus === 'SUCCESS' && refundRecord.payment?.printJobs) {
          const jobWithInvoice = refundRecord.payment.printJobs.find(j => j.invoice);
          if (jobWithInvoice?.invoice) {
            await issueCreditNoteForInvoice(jobWithInvoice.invoice.id, {
              refundId: refundRecord.id,
              amount: refundRecord.amount,
              reason: refundRecord.reason
            }).catch(err => logger.warn(`Credit note check on refund webhook: ${err.message}`));
          }
        }
      } else {
        logger.warn(`REFUND_STATUS_WEBHOOK could not match refund_id=${gatewayRefundId}, cf_refund_id=${cfRefundId}`);
      }

      await prisma.paymentEvent.update({
        where: { id: recordedEvent.id },
        data: { processed: true, processedAt: new Date() }
      });
    } else {
      logger.info(`Unhandled webhook event type: ${eventType}`);
      await prisma.paymentEvent.update({
        where: { id: recordedEvent.id },
        data: { processed: true, processedAt: new Date() }
      });
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error('Cashfree webhook processing error:', { error: error.message });
    res.status(200).send('Error logged');
  }
};

const refundOrder = async (req, res, next) => {
  try {
    const { id } = req.params; // jobId
    const reason = req.body?.reason || 'PrintGo Customer Requested Refund';
    const idempotencyKey = req.body?.idempotencyKey;
    const amount = req.body?.amount;

    const updatedJob = await paymentsService.refundPayment(id, req.user, reason, {
      idempotencyKey,
      amount
    });

    const io = req.app.get('io');
    if (io) {
      if (updatedJob.machineId) {
        io.to(`machine_${updatedJob.machineId}`).emit('job_status_changed', updatedJob);
      }
      io.to('admins').emit('job_status_changed', updatedJob);
      io.to(`job_${updatedJob.shortId}`).emit('job_status_changed', updatedJob);
    }

    res.json({ success: true, job: updatedJob, refund: updatedJob.refund });
  } catch (error) {
    next(error);
  }
};

/**
 * Demo Payment (1-Click Simulation)
 * Authorized strictly on Staging via isDemoPaymentPermitted.
 * Permanently blocked in Production. Requires session/user ownership.
 * Dispatches physical printing idempotently reusing startPrintingProcess.
 */
const demoPayment = async (req, res, next) => {
  try {
    if (!isDemoPaymentPermitted()) {
      logger.warn('Rejected request to disabled demo-pay endpoint: staging authorization check failed');
      return res.status(403).json({
        success: false,
        error: 'Demo payment endpoint is disabled'
      });
    }

    const { id } = req.params; // jobId (shortId)
    const ipAddress = req.ip || req.connection?.remoteAddress;

    const job = await prisma.printJob.findUnique({
      where: { shortId: id },
      include: { machine: true, document: true, payment: true }
    });

    const accessErr = checkJobAccess(req, job);
    if (accessErr) {
      return res.status(accessErr.status).json({ success: false, error: accessErr.error });
    }

    const accessCodeRequired = isDemoAccessCodeRequired();

    if (accessCodeRequired) {
      // Rate-limit failed access attempts per session and IP only when code protection is enabled.
      const sessionIdentifier = req.session?.sessionId || req.session?.code || req.headers['x-session-id'] || 'session_unknown';
      const ipIdentifier = ipAddress || 'ip_unknown';
      const rateLimitKey = `${sessionIdentifier}:${ipIdentifier}`;

      if (isDemoAccessRateLimited(rateLimitKey)) {
        logger.warn(`Demo payment rate limit exceeded for ${rateLimitKey}`);
        return res.status(429).json({
          success: false,
          error: 'Too many failed demo access code attempts. Rate limit exceeded. Please wait before retrying.'
        });
      }

      // Require and validate demo access code using constant-time timingSafeEqual.
      const providedCode = req.body?.accessCode || req.body?.demoAccessCode || req.headers['x-demo-access-code'];

      if (!providedCode || typeof providedCode !== 'string' || !providedCode.trim()) {
        recordDemoAccessFailure(rateLimitKey);
        logger.warn(`Demo payment rejected: missing access code from ${rateLimitKey}`);
        return res.status(400).json({
          success: false,
          error: 'Demo payment access code is required'
        });
      }

      if (!verifyDemoAccessCode(providedCode)) {
        recordDemoAccessFailure(rateLimitKey);
        logger.warn(`Demo payment rejected: invalid access code from ${rateLimitKey}`);
        return res.status(403).json({
          success: false,
          error: 'Invalid demo payment access code'
        });
      }

      // Clear failed attempt record on successful authentication.
      clearDemoAccessFailures(rateLimitKey);
    } else {
      // This optional-code mode is controlled only by the Staging backend environment.
      // The Staging-only demo guard and session/job ownership checks above still apply.
      logger.info(`Demo access-code prompt disabled by Staging configuration for job ${id}`);
    }

    // Idempotency: If already paid/waiting/printing/completed, return existing without re-dispatching
    if (job.status !== 'PENDING_PAYMENT') {
      logger.info(`Demo payment idempotency: Job ${job.shortId} already in status ${job.status}`);
      return res.json({
        success: true,
        dispatched: job.status === 'PRINTING' || job.status === 'COMPLETED',
        message: 'Job already paid',
        job
      });
    }

    const demoOrderId = `demo_order_${job.shortId}_${Date.now()}`;

    const { payment, updatedJob, wasAlreadyProcessed } = await prisma.$transaction(async (tx) => {
      // Re-fetch inside transaction with advisory lock to ensure strictly ONE concurrent request transitions the job
      if (typeof tx.$executeRawUnsafe === 'function') {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtext($1))`,
          `printjob_demo_pay_${job.id}`
        );
      }

      const freshJob = await tx.printJob.findUnique({
        where: { id: job.id },
        include: { payment: true }
      });

      if (!freshJob || freshJob.status !== 'PENDING_PAYMENT') {
        return { payment: freshJob?.payment, updatedJob: freshJob, wasAlreadyProcessed: true };
      }

      const newPayment = await tx.payment.create({
        data: {
          amount: job.cost,
          currency: 'INR',
          type: 'PRINT_JOB',
          status: 'SUCCESS',
          paymentMethod: 'demo',
          paymentGroup: 'simulated',
          gatewayOrderId: demoOrderId,
          paidAt: new Date()
        }
      });

      const updated = await tx.printJob.update({
        where: { id: job.id },
        data: {
          status: 'WAITING',
          paymentId: newPayment.id
        },
        include: { document: true, machine: true, payment: true }
      });

      if (tx.transaction && typeof tx.transaction.create === 'function') {
        await tx.transaction.create({
          data: {
            paymentId: newPayment.id,
            action: 'DEMO_PAYMENT_SIMULATION',
            status: 'SUCCESS',
            amount: job.cost,
            ipAddress: ipAddress || null,
            gatewayResponse: JSON.stringify({
              note: 'Simulated 1-click demo payment on Staging',
              printJobId: job.id,
              jobShortId: job.shortId,
              gatewayOrderId: demoOrderId
            })
          }
        });
      }

      return { payment: newPayment, updatedJob: updated, wasAlreadyProcessed: false };
    });

    logger.info(`⚡ Demo Payment confirmed for job ${job.shortId} (cost: ₹${job.cost}). Status: WAITING. Transaction logged.`);

    const io = req.app.get('io');
    if (io) {
      if (req.session?.sessionId) {
        io.to(req.session.sessionId).emit('kiosk_payment_success', { jobId: job.shortId });
      }
      io.to(`job_${job.shortId}`).emit('kiosk_payment_success', { jobId: job.shortId });
      io.to('admins').emit('job_status_changed', updatedJob);
    }

    // Call the approved physical printing dispatch function (reusing Cashfree queue path)
    let dispatched = false;
    let dispatchError = null;

    if (!wasAlreadyProcessed && updatedJob?.status === 'WAITING') {
      if (typeof queueService?.startPrintingProcess === 'function') {
        try {
          logger.info(`⚡ Demo Payment: Dispatching job ${updatedJob.shortId} to print queue.`);
          await queueService.startPrintingProcess(updatedJob.shortId, io);
          dispatched = true;
        } catch (dispatchErr) {
          dispatched = false;
          dispatchError = dispatchErr?.message || 'Print queue dispatch failed';
          logger.error(`Failed to dispatch demo print job ${updatedJob.shortId}:`, dispatchErr);
        }
      } else {
        dispatched = false;
        dispatchError = 'Print queue dispatcher is unavailable';
        logger.warn(`startPrintingProcess is unavailable for job ${updatedJob.shortId}`);
      }
    } else if (wasAlreadyProcessed) {
      dispatched = updatedJob?.status === 'PRINTING' || updatedJob?.status === 'COMPLETED';
    }

    const message = dispatched
      ? 'Demo payment confirmed and dispatched to printer'
      : (dispatchError
          ? `Demo payment confirmed, but print queue dispatch encountered an error: ${dispatchError}. Job is queued in WAITING state for operator retry.`
          : 'Demo payment confirmed');

    res.json({
      success: true,
      dispatched,
      message,
      job: updatedJob,
      payment,
      dispatchError: dispatchError || undefined
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createCashfreeOrder,
  verifyPayment,
  cashfreeWebhook,
  refundOrder,
  demoPayment
};
