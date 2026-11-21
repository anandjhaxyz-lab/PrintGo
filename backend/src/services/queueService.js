const { Queue, Worker } = require('bullmq');
const crypto = require('crypto');
const { connection } = require('./redisClient');
const prisma = require('../utils/prisma');
const { isValidJobTransition } = require('../utils/stateMachine');

/**
 * A queue item must never disappear while leaving a paid device-bound job in
 * WAITING. If authorization fails before Agent dispatch, terminally fail the
 * job, record the reason, notify watchers, and refund a successful payment.
 */
const failBlockedDeviceDispatch = async (job, expectedStatus, code, reason) => {
  if (!job?.shortId || !job?.printerDeviceId || !['WAITING', 'PRINTING'].includes(expectedStatus)) {
    return false;
  }
  // WAITING jobs have not entered the Agent/driver path and may only be
  // CANCELLED; once claimed as PRINTING, the state machine allows FAILED.
  const terminalStatus = expectedStatus === 'WAITING' ? 'CANCELLED' : 'FAILED';
  if (!isValidJobTransition(expectedStatus, terminalStatus)) {
    console.error(`Job ${job.shortId}: state machine rejected dispatch-block transition from ${expectedStatus} to ${terminalStatus}.`);
    return false;
  }

  const updateResult = await prisma.printJob.updateMany({
    where: {
      shortId: job.shortId,
      status: expectedStatus,
      printerDeviceId: job.printerDeviceId
    },
    data: { status: terminalStatus }
  });
  if (updateResult.count !== 1) {
    console.warn(`Job ${job.shortId}: dispatch failure was not applied because its state/binding changed concurrently.`);
    return false;
  }

  const errorDetails = `Device dispatch refused [${code}]: ${reason}`;
  try {
    await prisma.printHistory.create({
      data: {
        printJobId: job.id,
        success: false,
        errorDetails,
        completedAt: new Date()
      }
    });
  } catch (historyError) {
    console.error(`Job ${job.shortId}: could not write dispatch refusal history:`, historyError.message);
  }

  const statusEvent = {
    id: job.id,
    shortId: job.shortId,
    status: terminalStatus,
    error: reason,
    code
  };
  if (globalIo) {
    if (job.machineId) globalIo.to(`machine_${job.machineId}`).emit('job_status_changed', statusEvent);
    globalIo.to(`job_${job.shortId}`).emit('job_status_changed', statusEvent);
    if (job.machine?.companyId) {
      globalIo.to(`company_${job.machine.companyId}`).emit('job_status_changed', statusEvent);
    }
    globalIo.to('superadmins').emit('job_status_changed', statusEvent);
    globalIo.to('admins').emit('job_status_changed', statusEvent);
  }

  if (job.paymentId && job.payment?.status === 'SUCCESS') {
    try {
      const paymentsService = require('../modules/payments/payments.service');
      await paymentsService.refundPayment(
        job.shortId,
        null,
        `Automatic refund: physical printer dispatch was blocked (${code}). ${reason}`,
        {
          initiatedBy: 'SYSTEM',
          preserveJobStatus: true,
          idempotencyKey: `device_dispatch_blocked_${job.id}_${job.paymentId}`
        }
      );
    } catch (refundError) {
      console.error(`Job ${job.shortId}: automatic refund failed after dispatch refusal:`, refundError.message);
      try {
        const idempotencyKey = `device_dispatch_blocked_${job.id}_${job.paymentId}`;
        const existingFailed = await prisma.refund.findFirst({
          where: {
            OR: [
              { idempotencyKey },
              { paymentId: job.paymentId, printJobId: job.id }
            ]
          }
        });
        let failedRefundId = existingFailed?.id;
        if (!existingFailed) {
          const refundRecord = await prisma.refund.create({
            data: {
              idempotencyKey,
              paymentId: job.paymentId,
              printJobId: job.id,
              gatewayRefundId: `ref_blocked_${job.shortId}_${Date.now()}`,
              amount: job.payment?.amount || 0,
              currency: job.payment?.currency || 'INR',
              reason: `Automatic refund failed after physical printer dispatch blocked (${code}): ${reason}`,
              status: 'FAILED',
              failureReason: refundError.message,
              retryEligible: true,
              initiatedBy: 'SYSTEM'
            }
          });
          failedRefundId = refundRecord.id;
        }
        await prisma.reconciliationRecord.create({
          data: {
            paymentId: job.paymentId,
            refundId: failedRefundId || null,
            printJobId: job.id,
            status: 'PENDING_RECONCILIATION',
            discrepancyType: 'FAILED_AUTOMATIC_REFUND',
            details: JSON.stringify({
              code,
              reason,
              error: refundError.message,
              jobShortId: job.shortId
            })
          }
        }).catch(() => {});
      } catch (recordError) {
        console.error(`Failed to record persistent refund failure for job ${job.shortId}:`, recordError.message);
      }
    }
  }

  console.warn(`Job ${job.shortId} was marked ${terminalStatus} because device dispatch was refused [${code}].`);
  return true;
};

const isProductionRuntime = process.env.NODE_ENV === 'production';
const isRedisRequired = isProductionRuntime || process.env.QUEUE_REDIS_REQUIRED === 'true';

let printQueue = null;
let printWorker = null;
let workerReady = false;
let useRedis = Boolean(connection);

if (!useRedis) {
  if (isRedisRequired) {
    throw new Error('PrintGo production queue requires Redis; refusing to initialize an in-memory print queue.');
  }
  console.warn('BullMQ is not configured; using the development/test in-memory fallback.');
} else {
  try {
    printQueue = new Queue('printQueue', { connection });
  } catch (error) {
    if (isRedisRequired) {
      throw new Error(`Failed to initialize the durable print queue: ${error.message}`);
    }
    console.warn('BullMQ initialization failed, using the development/test in-memory fallback:', error.message);
    useRedis = false;
  }
}

let globalIo = null;

const MAX_PRINT_ATTEMPTS = 3;

const processJob = async (shortId, options = {}) => {
  const isAuthorizedRetry = Boolean(options.isAuthorizedRetry);
  try {
    const dbJob = await prisma.printJob.findUnique({
      where: { shortId },
      include: { document: true, printerDevice: true, payment: true }
    });
    if (!dbJob) return { success: false, code: 'JOB_NOT_FOUND', message: `Job ${shortId} not found` };

    // UP-02: Fast fail-closed check for legacy unverified attempts
    if (dbJob.legacyAttemptsUnknown || (dbJob.payment && dbJob.payment.legacyAttemptsUnknown)) {
      console.warn(`Job ${shortId}: Legacy transaction has unverified historical attempts. Re-dispatch is disallowed under UP-02.`);
      return {
        success: false,
        code: 'LEGACY_ATTEMPTS_EXHAUSTED',
        message: `Job ${shortId} belongs to a legacy transaction with unverified historical attempts. Re-dispatch is disallowed under fail-closed policy UP-02.`,
        attempts: MAX_PRINT_ATTEMPTS,
        maxAttempts: MAX_PRINT_ATTEMPTS
      };
    }

    // UP-02 Canonical Policy: Maximum 3 total authorized print attempts per transaction (including original)
    const currentAttempts = dbJob.printAttempts || 0;
    if (currentAttempts >= MAX_PRINT_ATTEMPTS) {
      console.warn(`Job ${shortId}: Maximum print attempts reached (${currentAttempts}/${MAX_PRINT_ATTEMPTS}). Disallowing physical print dispatch.`);
      return {
        success: false,
        code: 'MAX_PRINT_ATTEMPTS_EXCEEDED',
        message: `Maximum ${MAX_PRINT_ATTEMPTS} print attempts exceeded for job ${shortId}. Current attempts: ${currentAttempts}.`,
        attempts: currentAttempts,
        maxAttempts: MAX_PRINT_ATTEMPTS
      };
    }

    // Fast check on payment level if payment is already exhausted
    if (dbJob.payment) {
      const isExhausted = isAuthorizedRetry
        ? dbJob.payment.authorizedPrintAttempts > MAX_PRINT_ATTEMPTS
        : dbJob.payment.authorizedPrintAttempts >= MAX_PRINT_ATTEMPTS;

      if (isExhausted) {
        console.warn(`Payment ${dbJob.paymentId}: Transaction print attempts cap reached (${dbJob.payment.authorizedPrintAttempts}/${MAX_PRINT_ATTEMPTS}). Disallowing dispatch for job ${shortId}.`);
        return {
          success: false,
          code: 'MAX_PRINT_ATTEMPTS_EXCEEDED',
          message: `Maximum ${MAX_PRINT_ATTEMPTS} print attempts exceeded for payment transaction ${dbJob.paymentId}. Total attempts: ${dbJob.payment.authorizedPrintAttempts}.`,
          attempts: dbJob.payment.authorizedPrintAttempts,
          maxAttempts: MAX_PRINT_ATTEMPTS
        };
      }
    }

    // Device-bound jobs are dispatched only after the explicit feature gate and
    // a fresh DB check of Machine ownership, approval evidence and exact queue.
    // Legacy Machine-QR jobs (printerDeviceId=null) retain the original route.
    if (dbJob.printerDeviceId) {
      const device = dbJob.printerDevice;
      let blockedCode = null;
      let blockedReason = null;
      if (process.env.ENABLE_MULTI_PRINTER_DISPATCH !== 'true') {
        blockedCode = 'DISPATCH_FEATURE_DISABLED';
        blockedReason = 'Multi-printer dispatch is disabled. Please contact shop staff for assistance.';
      } else if (
        !device ||
        device.id !== dbJob.printerDeviceId ||
        device.machineId !== dbJob.machineId ||
        device.status !== 'ACTIVE' ||
        !device.approvedAt ||
        typeof device.windowsPrinterName !== 'string' ||
        !device.windowsPrinterName.trim()
      ) {
        blockedCode = 'PRINTER_DEVICE_UNAVAILABLE';
        blockedReason = 'The selected physical printer is no longer approved, active or correctly mapped. Please contact shop staff.';
      } else if (
        typeof dbJob.printerWindowsQueueName !== 'string' ||
        !dbJob.printerWindowsQueueName.trim() ||
        dbJob.printerWindowsQueueName !== device.windowsPrinterName
      ) {
        blockedCode = 'PRINTER_QUEUE_SNAPSHOT_MISMATCH';
        blockedReason = 'The printer queue mapping changed after this job was created. This job was not submitted to a different queue; please create a new print job.';
      }

      if (blockedCode) {
        await failBlockedDeviceDispatch(dbJob, 'WAITING', blockedCode, blockedReason);
        return { success: false, code: blockedCode, message: blockedReason };
      }
    }

    // Validate state transition using state machine
    if (!isValidJobTransition(dbJob.status, 'PRINTING')) {
      console.warn(`Job ${shortId}: cannot transition from ${dbJob.status} to PRINTING, skipping`);
      return {
        success: false,
        code: 'INVALID_TRANSITION',
        message: `Job ${shortId}: cannot transition from ${dbJob.status} to PRINTING.`
      };
    }

    // Authoritative Database Transaction-level Atomic Reservation:
    // Guarantees serialization across sibling jobs sharing the same paymentId,
    // and atomic claim of the PrintJob from WAITING to PRINTING.
    const executeReservation = async (client) => {
      // Step A: If paymentId is present, check and reserve attempts.
      // If isAuthorizedRetry is true:
      // The retry transaction in admin.routes.js already atomically incremented Payment.authorizedPrintAttempts before commit.
      // Therefore, we do not double-increment Payment.authorizedPrintAttempts here.
      // If isAuthorizedRetry is false:
      // This is a fresh/standard dispatch that must atomically claim an attempt on the Payment row.
      if (dbJob.paymentId) {
        if (!isAuthorizedRetry) {
          const payRes = await client.payment.updateMany({
            where: {
              id: dbJob.paymentId,
              authorizedPrintAttempts: { lt: MAX_PRINT_ATTEMPTS },
              legacyAttemptsUnknown: false
            },
            data: {
              authorizedPrintAttempts: { increment: 1 }
            }
          });

          if (payRes.count === 0) {
            const currentPayment = await client.payment.findUnique({
              where: { id: dbJob.paymentId },
              select: { authorizedPrintAttempts: true, legacyAttemptsUnknown: true }
            });
            if (currentPayment?.legacyAttemptsUnknown) {
              const err = new Error(`Payment transaction ${dbJob.paymentId} has unverified legacy attempt history.`);
              err.code = 'LEGACY_ATTEMPTS_EXHAUSTED';
              throw err;
            }
            const reservedAttempts = currentPayment?.authorizedPrintAttempts ?? MAX_PRINT_ATTEMPTS;
            const err = new Error(`Maximum ${MAX_PRINT_ATTEMPTS} print attempts exceeded for payment transaction ${dbJob.paymentId}. Total attempts: ${reservedAttempts}.`);
            err.code = 'MAX_PRINT_ATTEMPTS_EXCEEDED';
            err.attempts = reservedAttempts;
            err.maxAttempts = MAX_PRINT_ATTEMPTS;
            throw err;
          }
        } else {
          // For authorized retries, ensure payment does not have unverified legacy history or exceed cap
          const currentPayment = await client.payment.findUnique({
            where: { id: dbJob.paymentId },
            select: { authorizedPrintAttempts: true, legacyAttemptsUnknown: true }
          });
          if (currentPayment?.legacyAttemptsUnknown) {
            const err = new Error(`Payment transaction ${dbJob.paymentId} has unverified legacy attempt history.`);
            err.code = 'LEGACY_ATTEMPTS_EXHAUSTED';
            throw err;
          }
          if ((currentPayment?.authorizedPrintAttempts ?? 0) > MAX_PRINT_ATTEMPTS) {
            const err = new Error(`Maximum ${MAX_PRINT_ATTEMPTS} print attempts exceeded for payment transaction ${dbJob.paymentId}. Total attempts: ${currentPayment.authorizedPrintAttempts}.`);
            err.code = 'MAX_PRINT_ATTEMPTS_EXCEEDED';
            err.attempts = currentPayment.authorizedPrintAttempts;
            err.maxAttempts = MAX_PRINT_ATTEMPTS;
            throw err;
          }
        }
      }

      // Step B: Atomically claim PrintJob WAITING -> PRINTING and increment its printAttempts
      const jobRes = await client.printJob.updateMany({
        where: {
          shortId,
          status: 'WAITING',
          printerDeviceId: dbJob.printerDeviceId || null,
          printAttempts: { lt: MAX_PRINT_ATTEMPTS },
          legacyAttemptsUnknown: false
        },
        data: {
          status: 'PRINTING',
          printAttempts: { increment: 1 },
          reservedForRetry: false  // Clear reservation flag atomically with the WAITING→PRINTING transition
        }
      });

      if (jobRes.count === 0) {
        const err = new Error(`Cannot claim WAITING lock or maximum attempts reached for job ${shortId}.`);
        err.code = 'DISPATCH_CLAIM_FAILED';
        throw err;
      }

      const updated = await client.printJob.findUnique({
        where: { shortId },
        include: { document: true, printerDevice: true, payment: true }
      });

      return updated;
    };

    let updatedJob = null;
    try {
      if (typeof prisma.$transaction === 'function') {
        updatedJob = await prisma.$transaction(async (tx) => {
          return await executeReservation(tx);
        }, { maxWait: 5000, timeout: 10000 });
      } else {
        updatedJob = await executeReservation(prisma);
      }
    } catch (resErr) {
      if (resErr.code === 'MAX_PRINT_ATTEMPTS_EXCEEDED') {
        console.warn(`Job ${shortId}: Transaction print attempts cap reached. Disallowing dispatch.`);
        return {
          success: false,
          code: 'MAX_PRINT_ATTEMPTS_EXCEEDED',
          message: resErr.message,
          attempts: resErr.attempts || MAX_PRINT_ATTEMPTS,
          maxAttempts: MAX_PRINT_ATTEMPTS
        };
      }
      if (resErr.code === 'LEGACY_ATTEMPTS_EXHAUSTED') {
        console.warn(`Job ${shortId}: ${resErr.message}`);
        return {
          success: false,
          code: 'LEGACY_ATTEMPTS_EXHAUSTED',
          message: resErr.message,
          attempts: MAX_PRINT_ATTEMPTS,
          maxAttempts: MAX_PRINT_ATTEMPTS
        };
      }
      if (resErr.code === 'DISPATCH_CLAIM_FAILED') {
        console.warn(`Job ${shortId}: cannot claim WAITING lock or attempt limit reached, skipping physical print dispatch`);
        return {
          success: false,
          code: 'DISPATCH_CLAIM_FAILED',
          message: resErr.message
        };
      }
      throw resErr;
    }

    // Record persistent attempt audit trail in ActivityLog
    if (prisma.activityLog && typeof prisma.activityLog.create === 'function') {
      await prisma.activityLog.create({
        data: {
          action: 'PRINT_ATTEMPT_DISPATCHED',
          details: JSON.stringify({
            jobId: updatedJob.id,
            shortId: updatedJob.shortId,
            attempt: updatedJob.printAttempts,
            maxAttempts: MAX_PRINT_ATTEMPTS,
            machineId: updatedJob.machineId,
            printerDeviceId: updatedJob.printerDeviceId || null,
            timestamp: new Date().toISOString()
          }),
          machineId: updatedJob.machineId || null
        }
      }).catch((logErr) => console.error('Failed to log attempt in ActivityLog:', logErr.message));
    }

    // Re-check immediately before sending the Agent event. A concurrent Admin
    // disable/remap after the initial read must fail closed, never fall back.
    if (updatedJob?.printerDeviceId) {
      const device = updatedJob.printerDevice;
      const deviceStillValid = Boolean(
        process.env.ENABLE_MULTI_PRINTER_DISPATCH === 'true' &&
        device &&
        device.id === updatedJob.printerDeviceId &&
        device.machineId === updatedJob.machineId &&
        device.status === 'ACTIVE' &&
        device.approvedAt &&
        typeof device.windowsPrinterName === 'string' &&
        device.windowsPrinterName.trim() &&
        typeof updatedJob.printerWindowsQueueName === 'string' &&
        updatedJob.printerWindowsQueueName.trim() &&
        updatedJob.printerWindowsQueueName === device.windowsPrinterName
      );
      if (!deviceStillValid) {
        await failBlockedDeviceDispatch(
          updatedJob,
          'PRINTING',
          'PRINTER_DEVICE_CHANGED_BEFORE_DISPATCH',
          'The selected physical printer changed or became unavailable before Agent dispatch. Please contact shop staff.'
        );
        return;
      }
    }

    if (globalIo) {
        // Emit status change to machine room + admins only
        // Emit status change is now handled universally by Prisma $extends
        
        const printData = {
          jobId: updatedJob.shortId,
          fileUrl: (updatedJob.document && updatedJob.document.filename) ? updatedJob.document.filename.replace(/^https:\/\/localhost:5000/, 'http://localhost:5000') : '', 
          originalName: updatedJob.document ? updatedJob.document.originalName : '',
          pagesToPrint: updatedJob.pagesToPrint,
          settings: {
            color: updatedJob.color,
            duplex: updatedJob.duplex,
            copies: updatedJob.copies,
            pageRangeType: updatedJob.pageRangeType,
            customRange: updatedJob.customRange
          },
          price: updatedJob.cost,
          encryptedKey: updatedJob.encryptedKey,
          iv: updatedJob.iv,
          ...(updatedJob.printerDeviceId ? {
            printerDeviceId: updatedJob.printerDeviceId,
            windowsPrinterName: updatedJob.printerWindowsQueueName
          } : {})
        };
        
        if (updatedJob.machineId) {
          globalIo.to(`machine_${updatedJob.machineId}`).emit('physical_print_job', printData);
        } else {
          // No machineId assigned — cannot send to a specific printer
          // Log a warning instead of broadcasting to ALL sockets
          console.warn(`Job ${updatedJob.shortId} has no machineId — cannot route to printer agent`);
        }
      }
      
      console.log(`Job ${shortId} is now PRINTING. Waiting for agent feedback...`);
      // The physical printer agent will now respond with 'print_spooler_success' or 'print_spooler_error'
      // which will be handled in socket.js to mark the job as COMPLETED or FAILED.
      return {
        success: true,
        shortId,
        attempts: updatedJob.printAttempts,
        maxAttempts: MAX_PRINT_ATTEMPTS
      };
  } catch(e) {
    console.error(`Error processing job ${shortId}:`, e);
    throw e;
  }
};

const initWorker = async (io) => {
  globalIo = io;
  if (!useRedis || !printQueue) return null;
  if (printWorker && workerReady) return printWorker;

  try {
    // Keep the backend event publisher single-threaded so Agent receipt order is
    // deterministic. Per-device lanes in the Agent serialize same-printer work
    // while allowing independent printers to download/submit in parallel.
    printWorker = new Worker('printQueue', async (job) => {
      const { shortId, isAuthorizedRetry } = job.data;
      await processJob(shortId, { isAuthorizedRetry });
    }, { connection, concurrency: 1 });

    printWorker.on('failed', (job, err) => {
      console.error(`Physical Print Job ${job.id} failed without automatic retry: ${err.message}`);
    });

    await Promise.all([
      printQueue.waitUntilReady(),
      printWorker.waitUntilReady()
    ]);
    workerReady = true;
    reconcileStrandedWaitingJobs({ io }).catch(err => {
      console.error('[STRANDED_JOB_RECONCILER] Initial worker startup sweep failed:', err.message);
    });
    return printWorker;
  } catch (error) {
    workerReady = false;
    if (printWorker) {
      await printWorker.close().catch(() => {});
      printWorker = null;
    }
    if (isRedisRequired) {
      throw new Error(`Durable print worker failed to become ready: ${error.message}`);
    }
    useRedis = false;
    console.warn('BullMQ worker failed to start; using the development/test in-memory fallback:', error.message);
    return null;
  }
};

const startPrintingProcess = async (shortId, io, options = {}) => {
  if (io) globalIo = io;

  if (useRedis && printQueue) {
    let timeoutId;
    try {
      const enqueuePromise = printQueue.add('printJob', {
        shortId,
        isAuthorizedRetry: Boolean(options.isAuthorizedRetry)
      }, {
        jobId: `print_${shortId}`,
        attempts: 1, // Preserve the no-automatic-reprint safety policy.
        removeOnComplete: true,
        removeOnFail: false
      });

      await Promise.race([
        enqueuePromise,
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('Redis queue operation timed out after 2500ms')),
            2500
          );
        })
      ]);
    } catch (error) {
      if (isRedisRequired) {
        // Do not dispatch a physical print outside the durable queue in production.
        throw new Error(`Durable print queue unavailable for job ${shortId}; no in-memory dispatch was attempted: ${error.message}`);
      }
      console.warn(`Redis queue unavailable (${error.message}), using the development/test in-memory fallback.`);
      try {
        await processJob(shortId, options);
      } catch (processingError) {
        // Preserve the existing non-production fallback contract. BullMQ Worker
        // executions still receive the rethrow from processJob above.
        console.error(`Development/test in-memory fallback failed for job ${shortId}:`, processingError);
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  } else if (isRedisRequired) {
    throw new Error('Durable print queue is not ready; refusing an in-memory physical print dispatch.');
  } else {
    try {
      return await processJob(shortId, options);
    } catch (processingError) {
      // Keep development/test callers non-throwing on local direct dispatch.
      // The durable BullMQ Worker path still records thrown processor errors.
      console.error(`Development/test in-memory fallback failed for job ${shortId}:`, processingError);
      throw processingError;
    }
  }
};

const getQueueHealth = () => {
  const workerRunning = Boolean(
    printWorker &&
    typeof printWorker.isRunning === 'function' &&
    printWorker.isRunning()
  );
  return {
    configured: Boolean(connection && printQueue),
    redisReady: Boolean(connection && connection.status === 'ready'),
    workerReady: workerReady && workerRunning,
    ready: Boolean(useRedis && connection && connection.status === 'ready' && printQueue && workerReady && workerRunning)
  };
};

const closeQueueService = async () => {
  clearInterval(cleanupTimer);
  workerReady = false;
  const worker = printWorker;
  const queue = printQueue;
  printWorker = null;
  printQueue = null;
  if (worker) await worker.close();
  if (queue) await queue.close();
};

const calculateEstimatedWaitTime = async (shortId) => {
  try {
    const queueJobs = await prisma.printJob.findMany({
      where: {
        status: { in: ['WAITING', 'PRINTING'] }
      },
      orderBy: { createdAt: 'asc' }
    });

    let waitTimeSeconds = 0;
    let jobsAhead = 0;

    for (const j of queueJobs) {
      if (j.shortId === shortId) break; 
      const pagesToPrint = j.pagesToPrint || 1;
      const copies = j.copies || 1;
      waitTimeSeconds += (pagesToPrint * copies * 2);
      jobsAhead++;
    }
    
    if (jobsAhead > 0) {
      waitTimeSeconds += (jobsAhead * 2); 
    }

    return Math.max(waitTimeSeconds, 3);
  } catch (error) {
    console.error('Error calculating ETA:', error);
    return 3;
  }
};

const ABANDONED_JOB_TTL_MS = 60 * 60 * 1000;

/**
 * Prisma filter matching only genuinely abandoned, unlinked PENDING_PAYMENT jobs.
 * Applied identically during candidate selection and atomic in-transaction deletion.
 */
const buildAbandonedJobWhere = (oneHourAgo) => ({
  status: 'PENDING_PAYMENT',
  createdAt: { lt: oneHourAgo },
  paymentId: null,
  payment: { is: null },
  invoice: { is: null },
  printHistory: { none: {} },
  isTest: false
});

/**
 * Checks both relational FKs and non-FK scalar references (printJobId / gatewayOrderId)
 * before permitting physical deletion of a PrintJob record.
 */
const hasProtectedJobReferences = async (db, job) => {
  const orderPrefixes = [
    { gatewayOrderId: { startsWith: `order_${job.shortId}_` } },
    { gatewayOrderId: { startsWith: `demo_order_${job.shortId}_` } }
  ];

  const [
    invoiceCount,
    historyCount,
    refundCount,
    creditNoteCount,
    reconciliationCount,
    paymentCount,
    paymentEventCount
  ] = await Promise.all([
    db.invoice.count({ where: { printJobId: job.id } }),
    db.printHistory.count({ where: { printJobId: job.id } }),
    db.refund.count({ where: { printJobId: job.id } }),
    db.creditNote.count({ where: { printJobId: job.id } }),
    db.reconciliationRecord.count({ where: { printJobId: job.id } }),
    db.payment.count({ where: { OR: orderPrefixes } }),
    db.paymentEvent.count({ where: { OR: orderPrefixes } })
  ]);

  return (
    invoiceCount > 0 ||
    historyCount > 0 ||
    refundCount > 0 ||
    creditNoteCount > 0 ||
    reconciliationCount > 0 ||
    paymentCount > 0 ||
    paymentEventCount > 0
  );
};

/**
 * Safely deletes abandoned PENDING_PAYMENT jobs one isolated transaction at a time.
 * Document files are removed strictly AFTER database transaction commit.
 */
const cleanupAbandonedJobs = async (options = {}) => {
  const db = options.prismaClient || prisma;
  const nowMs = options.now instanceof Date ? options.now.getTime() : Date.now();
  const ttlMs = typeof options.ttlMs === 'number' ? options.ttlMs : ABANDONED_JOB_TTL_MS;
  const oneHourAgo = new Date(nowMs - ttlMs);
  const deleteFileFn = options.deleteFileFn || require('../utils/storage').deleteFile;

  const baseWhere = buildAbandonedJobWhere(oneHourAgo);
  const candidateWhere = Array.isArray(options.jobIds)
    ? { AND: [baseWhere, { id: { in: options.jobIds } }] }
    : baseWhere;

  const candidates = await db.printJob.findMany({
    where: candidateWhere,
    include: { document: true },
    orderBy: { createdAt: 'asc' }
  });

  const summary = {
    scannedCount: candidates.length,
    deletedCount: 0,
    deletedJobIds: [],
    skippedCount: 0,
    filesDeleted: 0,
    orphanedFiles: [],
    errors: []
  };

  for (const candidate of candidates) {
    let txOutcome = { deleted: false, filenameToDelete: null };

    try {
      txOutcome = await db.$transaction(async (tx) => {
        const freshJob = await tx.printJob.findUnique({
          where: { id: candidate.id },
          include: { document: true, invoice: true, payment: true }
        });

        if (
          !freshJob ||
          freshJob.status !== 'PENDING_PAYMENT' ||
          !(freshJob.createdAt < oneHourAgo) ||
          freshJob.paymentId !== null ||
          freshJob.payment !== null ||
          freshJob.invoice !== null ||
          freshJob.isTest !== false
        ) {
          return { deleted: false, filenameToDelete: null };
        }

        if (await hasProtectedJobReferences(tx, freshJob)) {
          return { deleted: false, filenameToDelete: null };
        }

        const deleteRes = await tx.printJob.deleteMany({
          where: {
            id: freshJob.id,
            ...baseWhere
          }
        });

        if (deleteRes.count !== 1) {
          return { deleted: false, filenameToDelete: null };
        }

        const remainingDocumentRefs = freshJob.documentId
          ? await tx.printJob.count({ where: { documentId: freshJob.documentId } })
          : 0;

        return {
          deleted: true,
          filenameToDelete: remainingDocumentRefs === 0 ? (freshJob.document?.filename || null) : null
        };
      });
    } catch (jobErr) {
      summary.errors.push({ jobId: candidate.id, shortId: candidate.shortId, error: jobErr.message });
      console.error(`Cleanup skipped for job ${candidate.shortId} (${candidate.id}) due to DB error: ${jobErr.message}`);
      continue;
    }

    if (!txOutcome.deleted) {
      summary.skippedCount++;
      continue;
    }

    summary.deletedCount++;
    summary.deletedJobIds.push(candidate.id);

    if (txOutcome.filenameToDelete) {
      try {
        const fileDeleted = await deleteFileFn(txOutcome.filenameToDelete);
        if (fileDeleted === false) {
          throw new Error('Storage deleteFile returned false');
        }
        summary.filesDeleted++;
      } catch (fileErr) {
        summary.orphanedFiles.push({
          jobId: candidate.id,
          shortId: candidate.shortId,
          filename: txOutcome.filenameToDelete,
          error: fileErr.message
        });
        console.error(
          `[ORPHANED_FILE_CLEANUP] Deleted PrintJob ${candidate.shortId} (${candidate.id}), ` +
          `but failed to delete file '${txOutcome.filenameToDelete}': ${fileErr.message}`
        );
      }
    }
  }

  if (summary.deletedCount > 0) {
    console.log(`[CLEANUP] Removed ${summary.deletedCount} abandoned PENDING_PAYMENT job(s) from database.`);
  }

  return summary;
};

/**
 * Safely handles PRINTING jobs that have exceeded the active execution threshold.
 *
 * UP-03 Ambiguity Lockout & UP-06 Fail-Closed Policy:
 * 1. NEVER marks PRINTING as FAILED solely because a time threshold elapsed.
 * 2. NEVER automatically refunds a PRINTING job merely because it is old.
 * 3. Does not delete, reset or redispatch an ambiguous job.
 * 4. Keeps unresolved physical outcomes in PRINTING until trustworthy Agent
 *    journal reconciliation or authorized operator resolution.
 * 5. Records a structured recovery incident (ReconciliationRecord) and alerts administrators.
 * 6. If the authenticated Agent is connected, requests journal reconciliation (reconcile_active_jobs).
 * 7. If the Agent is offline or journal evidence is unavailable, retains fail-closed state (PRINTING).
 */
const reconcileStuckPrintingJobs = async (options = {}) => {
  const db = options.prismaClient || prisma;
  const nowMs = options.now instanceof Date ? options.now.getTime() : (typeof options.now === 'number' ? options.now : Date.now());
  const thresholdMs = typeof options.thresholdMs === 'number' ? options.thresholdMs : 15 * 60000;
  const cutoffDate = new Date(nowMs - thresholdMs);
  const io = options.io !== undefined ? options.io : globalIo;

  const stuckJobs = await db.printJob.findMany({
    where: {
      status: 'PRINTING',
      updatedAt: { lt: cutoffDate }
    },
    include: {
      payment: true,
      printerDevice: true,
      machine: true
    }
  });

  const summary = {
    scannedCount: stuckJobs.length,
    reconciliationRequestedCount: 0,
    failClosedRetainedCount: 0,
    incidentLoggedCount: 0
  };

  for (const job of stuckJobs) {
    summary.failClosedRetainedCount++;
    const durationMins = Math.round((nowMs - new Date(job.updatedAt).getTime()) / 60000);
    console.warn(`⚠️ [AMBIGUITY LOCKOUT] Job ${job.shortId} has remained in PRINTING for ~${durationMins}m. Retaining PRINTING status (no automatic failure or refund).`);

    // 1. Record persistent structured reconciliation incident if one does not already exist
    if (db.reconciliationRecord && typeof db.reconciliationRecord.findFirst === 'function') {
      try {
        const existingIncident = await db.reconciliationRecord.findFirst({
          where: {
            printJobId: job.id,
            discrepancyType: 'STUCK_PRINTING_JOB',
            resolved: false
          }
        });

        if (!existingIncident) {
          await db.reconciliationRecord.create({
            data: {
              printJobId: job.id,
              paymentId: job.paymentId || null,
              status: 'MANUAL_REVIEW_REQUIRED',
              discrepancyType: 'STUCK_PRINTING_JOB',
              details: JSON.stringify({
                jobId: job.id,
                shortId: job.shortId,
                machineId: job.machineId,
                printerDeviceId: job.printerDeviceId || null,
                windowsPrinterName: job.printerWindowsQueueName || job.printerDevice?.windowsPrinterName || null,
                stuckDurationMinutes: durationMins,
                reason: `Job remained in PRINTING state beyond ${Math.round(thresholdMs / 60000)} minute threshold. Physical outcome is unverified; fail-closed policy locks job in PRINTING until authenticated journal reconciliation or authorized operator resolution.`
              })
            }
          });
          summary.incidentLoggedCount++;
        }
      } catch (recErr) {
        console.error(`Failed to record structured reconciliation incident for stuck job ${job.shortId}:`, recErr.message);
      }
    }

    // 2. Alert Administrators via WebSocket
    if (io) {
      const alertPayload = {
        type: 'STUCK_PRINTING_JOB',
        jobId: job.id,
        shortId: job.shortId,
        machineId: job.machineId,
        printerDeviceId: job.printerDeviceId || null,
        durationMinutes: durationMins,
        status: 'PRINTING',
        ambiguous: true,
        message: `Print job ${job.shortId} is ambiguous in PRINTING for >${Math.round(thresholdMs / 60000)} mins. Automatic refund suppressed. Requires agent journal reconciliation or physical operator inspection.`
      };
      if (typeof io.to === 'function') {
        io.to('superadmins').emit('job_status_changed', alertPayload);
        io.to('admins').emit('job_status_changed', alertPayload);
        if (job.machine?.companyId) {
          io.to(`company_${job.machine.companyId}`).emit('job_status_changed', alertPayload);
        }
      }
    }

    // 3. If authenticated agent is connected on socket, request journal reconciliation
    if (job.machineId) {
      try {
        const requestId = `rec_stuck_${job.machineId}_${Date.now()}_${crypto.randomUUID()}`;
        const jobBindings = {
          [job.shortId]: job.printerDeviceId ? {
            printerDeviceId: job.printerDeviceId,
            windowsPrinterName: job.printerWindowsQueueName || job.printerDevice?.windowsPrinterName || null
          } : null
        };

        const socketModule = require('../socket');
        const requestPrinterReconciliation = socketModule?.requestPrinterReconciliation;

        if (typeof requestPrinterReconciliation === 'function') {
          const recResult = requestPrinterReconciliation(io, job.machineId, {
            requestId,
            jobIds: [job.shortId],
            jobBindings
          });
          if (recResult?.success) {
            summary.reconciliationRequestedCount++;
          }
        } else if (io && typeof io.to === 'function') {
          io.to(`machine_${job.machineId}`).emit('reconcile_active_jobs', {
            requestId,
            jobIds: [job.shortId],
            jobBindings
          });
          summary.reconciliationRequestedCount++;
        }
      } catch (emitErr) {
        console.error(`Could not emit reconciliation request for stuck job ${job.shortId}:`, emitErr.message);
      }
    }
  }

  return summary;
};

/**
 * UP-02 / Concern B: Reconciles and safely dispatches any jobs stranded in WAITING.
 * Resolves the crash window between admin retry DB commit (FAILED -> WAITING) and queue dispatch.
 * Scans for jobs with status: 'WAITING', legacyAttemptsUnknown: false, printAttempts: { lt: MAX_PRINT_ATTEMPTS }.
 * Re-verifies payment validity, refund status, and attempt caps before delegating to startPrintingProcess.
 */
const reconcileStrandedWaitingJobs = async (options = {}) => {
  const db = options.prismaClient || prisma;
  const io = options.io !== undefined ? options.io : globalIo;
  const nowMs = options.now instanceof Date ? options.now.getTime() : Date.now();
  const thresholdMs = typeof options.thresholdMs === 'number' ? options.thresholdMs : 30000; // 30s threshold default
  const cutoffDate = new Date(nowMs - thresholdMs);

  const strandedJobs = await db.printJob.findMany({
    where: {
      status: 'WAITING',
      updatedAt: { lt: cutoffDate },
      legacyAttemptsUnknown: false,
      printAttempts: { lt: MAX_PRINT_ATTEMPTS }
    },
    include: {
      payment: true,
      printerDevice: true,
      machine: true
    }
  });

  const summary = {
    scannedCount: strandedJobs.length,
    dispatchedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    errors: []
  };

  for (const job of strandedJobs) {
    // 1. Payment sanity: if payment is linked, must be SUCCESS
    if (job.payment && job.payment.status !== 'SUCCESS') {
      summary.skippedCount++;
      continue;
    }

    // 2. Mutual safety with refunds: cannot dispatch if active or completed refund exists
    if (job.paymentId && db.refund) {
      try {
        const activeRefund = await db.refund.findFirst({
          where: {
            paymentId: job.paymentId,
            status: { in: ['SUCCESS', 'PROCESSING', 'PENDING'] }
          }
        });
        if (activeRefund) {
          summary.skippedCount++;
          continue;
        }
      } catch (refErr) {
        summary.failedCount++;
        summary.errors.push({ shortId: job.shortId, error: refErr.message });
        continue;
      }
    }

    // 3. Attempt ceiling check on payment
    if (job.payment && (job.payment.authorizedPrintAttempts > MAX_PRINT_ATTEMPTS || job.payment.legacyAttemptsUnknown)) {
      summary.skippedCount++;
      continue;
    }

    // Determine whether this attempt was already reserved on this specific PrintJob row
    // by an authorized admin retry transaction prior to crash. Uses the per-job
    // reservedForRetry flag set atomically in admin.routes.js — eliminates the aggregate
    // heuristic that could not distinguish which sibling owns the reservation.
    const alreadyReserved = Boolean(job.reservedForRetry);

    // 4. Safe dispatch via startPrintingProcess (which atomically claims WAITING -> PRINTING)
    try {
      console.log(`[STRANDED_JOB_RECONCILER] Resuming stranded WAITING job ${job.shortId}...`);
      await startPrintingProcess(job.shortId, io, { isAuthorizedRetry: alreadyReserved });
      summary.dispatchedCount++;
    } catch (dispatchErr) {
      summary.failedCount++;
      summary.errors.push({ shortId: job.shortId, error: dispatchErr.message });
      console.error(`[STRANDED_JOB_RECONCILER] Error dispatching stranded job ${job.shortId}:`, dispatchErr.message);
    }
  }

  return summary;
};

// Cleanup abandoned jobs, audit stuck PRINTING jobs, and cleanup expired files every 15 minutes
const cleanupTimer = setInterval(async () => {
  try {
    const { deleteFile } = require('../utils/storage');

    // 1. Delete genuinely abandoned unlinked PENDING_PAYMENT jobs safely
    await cleanupAbandonedJobs({ deleteFileFn: deleteFile });

    // 2. Audit stuck PRINTING jobs (Ambiguity lockout - fail-closed retention, NO auto-failure, NO auto-refund)
    await reconcileStuckPrintingJobs();

    // 3. Delete files for COMPLETED, FAILED, and REFUNDED jobs older than 1 hour
    await cleanupExpiredJobFiles({ deleteFileFn: deleteFile });

    // 4. Reconcile stranded WAITING jobs (addresses crash window between retry DB commit and queue dispatch)
    await reconcileStrandedWaitingJobs();
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}, 15 * 60 * 1000);

if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

/**
 * Safely deletes files for COMPLETED, FAILED, and REFUNDED jobs older than the retention period.
 * Excludes documents already cleaned (filename === '') and isolates errors per record.
 */
const cleanupExpiredJobFiles = async (options = {}) => {
  const db = options.prismaClient || prisma;
  const nowMs = options.now instanceof Date ? options.now.getTime() : Date.now();
  const retentionMs = typeof options.retentionMs === 'number' ? options.retentionMs : 3600000; // 1 hour default
  const cutoffDate = new Date(nowMs - retentionMs);
  const deleteFileFn = options.deleteFileFn || require('../utils/storage').deleteFile;

  const oldFinishedJobs = (await db.printJob.findMany({
    where: {
      status: { in: ['COMPLETED', 'FAILED', 'REFUNDED'] },
      updatedAt: { lt: cutoffDate },
      document: {
        filename: { not: '' }
      }
    },
    include: { document: true }
  })) || [];

  const summary = {
    scannedCount: oldFinishedJobs.length,
    cleanedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    errors: []
  };

  for (const job of oldFinishedJobs) {
    try {
      if (!job.document || !job.document.filename) {
        summary.skippedCount++;
        continue;
      }

      // Check if another active job is still referencing this document
      if (job.document.id) {
        const activeSiblingCount = await db.printJob.count({
          where: {
            documentId: job.document.id,
            id: { not: job.id },
            status: { in: ['PENDING_PAYMENT', 'PAID', 'PRINTING'] }
          }
        });

        if (activeSiblingCount > 0) {
          summary.skippedCount++;
          continue;
        }
      }

      const fileDeleted = await deleteFileFn(job.document.filename);
      if (fileDeleted === false) {
        summary.failedCount++;
        summary.errors.push({
          jobId: job.id,
          shortId: job.shortId,
          error: 'Storage deleteFile returned false'
        });
        console.error(`Failed to delete storage file for job ${job.shortId}. Skipping DB update.`);
        continue;
      }

      // Clear filename in DB with empty string (satisfies non-nullable String schema)
      await db.document.update({
        where: { id: job.document.id },
        data: {
          filename: '',
          originalName: 'File deleted (retention period ended)'
        }
      });

      summary.cleanedCount++;
      console.log(`🧹 Deleted stale file for job ${job.shortId}.`);
    } catch (jobErr) {
      summary.failedCount++;
      summary.errors.push({
        jobId: job.id,
        shortId: job.shortId,
        error: jobErr.message
      });
      console.error(`Error deleting stale file for job ${job.shortId}:`, jobErr.message);
    }
  }

  return summary;
};

module.exports = {
  MAX_PRINT_ATTEMPTS,
  processJob,
  startPrintingProcess,
  calculateEstimatedWaitTime,
  initWorker,
  cleanupAbandonedJobs,
  cleanupExpiredJobFiles,
  reconcileStuckPrintingJobs,
  reconcileStrandedWaitingJobs,
  buildAbandonedJobWhere,
  hasProtectedJobReferences,
  getQueueHealth,
  closeQueueService
};
