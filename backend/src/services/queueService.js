const { Queue, Worker } = require('bullmq');
const { connection } = require('./redisClient');
const prisma = require('../utils/prisma');
const { isValidJobTransition } = require('../utils/stateMachine');

let printQueue = null;
let useRedis = !!process.env.REDIS_HOST; // Use Redis if configured

try {
  if (useRedis) {
    printQueue = new Queue('printQueue', { connection });
  } else {
    throw new Error('REDIS_HOST not configured');
  }
} catch(e) {
  if (process.env.NODE_ENV === 'production') {
    console.warn("⚠️ WARNING: BullMQ requires Redis in production for reliable scaling. Falling back to in-memory queue (not recommended for multi-instance deployments).");
  } else {
    console.warn("BullMQ initialization failed, using in-memory queue fallback.");
  }
  useRedis = false;
}

let globalIo = null;

const processJob = async (shortId) => {
  try {
    // 1. Atomic conditional claim: transition strictly from WAITING -> PRINTING
    const claimResult = await prisma.printJob.updateMany({
      where: {
        shortId,
        status: 'WAITING'
      },
      data: {
        status: 'PRINTING'
      }
    });

    if (claimResult.count === 0) {
      // Check current job status to provide clear, observable logging
      const existingJob = await prisma.printJob.findUnique({
        where: { shortId },
        select: { id: true, status: true }
      });
      if (!existingJob) {
        console.warn(`Job ${shortId}: not found in database, skipping`);
      } else {
        console.warn(`Job ${shortId}: cannot claim for printing (current status: ${existingJob.status}), skipping duplicate/invalid dispatch`);
      }
      return null;
    }

    // 2. Job claimed atomically. Fetch document and full details for physical print dispatch.
    const updatedJob = await prisma.printJob.findUnique({
      where: { shortId },
      include: { document: true }
    });

    if (!updatedJob) {
      console.error(`[POST_CLAIM_ERROR] Job ${shortId}: claimed successfully but record could not be re-fetched from database`);
      return null;
    }

    // Check document presence
    if (!updatedJob.document || !updatedJob.document.filename) {
      console.error(`[POST_CLAIM_ERROR] Job ${shortId}: missing document or filename. Cannot print. Marking job FAILED.`);
      await prisma.printJob.update({
        where: { shortId },
        data: { status: 'FAILED' }
      });
      return null;
    }

    // Check machine assignment
    if (!updatedJob.machineId) {
      console.error(`[POST_CLAIM_ERROR] Job ${shortId}: no machineId assigned. Cannot route to printer. Marking job FAILED.`);
      await prisma.printJob.update({
        where: { shortId },
        data: { status: 'FAILED' }
      });
      return null;
    }

    if (globalIo) {
      // Emit status change to machine room + admins only
      // Emit status change is now handled universally by Prisma $extends
      
      const printData = {
        jobId: updatedJob.shortId,
        fileUrl: updatedJob.document.filename.replace(/^https:\/\/localhost:5000/, 'http://localhost:5000'),
        originalName: updatedJob.document.originalName || '',
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
        iv: updatedJob.iv
      };
      
      try {
        globalIo.to(`machine_${updatedJob.machineId}`).emit('physical_print_job', printData);
      } catch (socketErr) {
        console.error(`[POST_CLAIM_ERROR] Job ${shortId}: Socket emission to machine_${updatedJob.machineId} failed: ${socketErr.message}`);
        // Ambiguous-job safety:
        // Do NOT reset to WAITING because physical print dispatch may already have partially occurred.
        // Leaving in PRINTING guarantees the 15-minute recovery cleaner safely marks FAILED and refunds if unacknowledged.
        throw socketErr;
      }
    }

    console.log(`Job ${shortId} is now PRINTING. Waiting for agent feedback...`);
    // The physical printer agent will now respond with 'print_spooler_success' or 'print_spooler_error'
    // which will be handled in socket.js to mark the job as COMPLETED or FAILED.
    return updatedJob;
  } catch(e) {
    console.error(`Error processing job ${shortId}:`, e);
    throw e;
  }
};

const initWorker = (io) => {
  globalIo = io;
  if (!useRedis) return null;
  
  try {
    const worker = new Worker('printQueue', async (job) => {
      const { shortId } = job.data;
      await processJob(shortId);
    }, { connection, concurrency: 1 });

    worker.on('failed', (job, err) => {
      console.error(`Physical Print Job ${job.id} failed without automatic retry: ${err.message}`);
    });
    return worker;
  } catch(e) {
    useRedis = false;
    console.warn("Failed to start BullMQ worker, falling back to in-memory.");
    return null;
  }
};

const startPrintingProcess = async (shortId, io) => {
  if (io) globalIo = io;
  
  if (useRedis && printQueue) {
    try {
      const enqueuedJob = await printQueue.add(
        'printJob',
        { shortId },
        {
          jobId: `print_${shortId}`, // Deterministic BullMQ job identity
          attempts: 1, // Single execution guarantee for physical printing (NO AUTOMATIC RETRIES)
          removeOnComplete: true,
          removeOnFail: false // Retain failed physical job records for operator inspection
        }
      );
      return enqueuedJob;
    } catch(e) {
      // Observable error: BullMQ is the sole dispatch mechanism when Redis is configured.
      // Under no circumstances do we fall back to direct in-memory processJob() on enqueue failure or timeout.
      console.error(`Failed to enqueue job ${shortId} to BullMQ: ${e.message}`);
      throw e;
    }
  } else {
    // In-memory fallback: strictly for local development/testing where Redis is not configured
    return await processJob(shortId);
  }
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
 * P1-02/P1-05 Safety: Evaluates and recovers stuck PRINTING jobs safely.
 * Excludes ambiguous jobs and rechecks eligibility atomically inside a transaction.
 */
const cleanupStuckPrintingJobs = async (options = {}) => {
  const db = options.prismaClient || prisma;
  const nowMs = options.now instanceof Date ? options.now.getTime() : Date.now();
  const fifteenMinsAgo = new Date(nowMs - (options.timeoutMs || 15 * 60000));
  const refundService = options.refundService || require('./refund.service');

  const stuckJobs = await db.printJob.findMany({
    where: {
      status: 'PRINTING',
      updatedAt: { lt: fifteenMinsAgo },
      printHistory: {
        none: {
          success: false,
          errorDetails: {
            contains: 'Ambiguous outcome'
          }
        }
      }
    }
  });

  const results = {
    scanned: stuckJobs.length,
    failed: 0,
    refunded: 0,
    skipped: 0
  };

  for (const job of stuckJobs) {
    let shouldRefund = false;
    let targetPaymentId = null;

    try {
      await db.$transaction(async (tx) => {
        // Concurrency Guard: Atomic conditional transition from PRINTING -> FAILED.
        // Requires:
        // 1. Exact job ID match
        // 2. Status is still PRINTING
        // 3. updatedAt is still older than 15 minutes
        // 4. Zero ambiguous PrintHistory records exist
        const updateResult = await tx.printJob.updateMany({
          where: {
            id: job.id,
            status: 'PRINTING',
            updatedAt: { lt: fifteenMinsAgo },
            printHistory: {
              none: {
                success: false,
                errorDetails: {
                  contains: 'Ambiguous outcome'
                }
              }
            }
          },
          data: {
            status: 'FAILED'
          }
        });

        // If count === 0, the job was modified, resolved, touched, or acquired ambiguity concurrently.
        if (updateResult.count === 0) {
          results.skipped++;
          return;
        }

        results.failed++;

        if (job.paymentId) {
          shouldRefund = true;
          targetPaymentId = job.paymentId;
        }
      });
    } catch (txErr) {
      console.error(`[CLEANUP_ERROR] Failed during atomic conditional transition to FAILED for job ${job.shortId}:`, txErr.message);
      continue;
    }

    if (shouldRefund && targetPaymentId) {
      try {
        await refundService.createRefund({
          paymentId: targetPaymentId,
          reason: 'Automated crash recovery refund: print job stuck in PRINTING for >15 minutes',
          idempotencyKey: `auto_recovery_${job.id}_${targetPaymentId}`,
          initiatedBy: 'SYSTEM'
        });
        results.refunded++;
      } catch (refundErr) {
        console.error(`Automated refund failed/skipped for stuck job ${job.shortId}:`, refundErr.message);
      }
    }
  }

  return results;
};

// Cleanup abandoned jobs and stuck PRINTING jobs every 15 minutes
const cleanupTimer = setInterval(async () => {
  try {
    const oneHourAgo = new Date(Date.now() - ABANDONED_JOB_TTL_MS);
    const { deleteFile } = require('../utils/storage');

    // 1. Delete genuinely abandoned unlinked PENDING_PAYMENT jobs safely
    await cleanupAbandonedJobs({ deleteFileFn: deleteFile });

    // 2. P3-004 / P1-02: Fail and refund stuck PRINTING jobs (Agent crash recovery)
    await cleanupStuckPrintingJobs();

    // 3. Delete files for COMPLETED, FAILED, and REFUNDED jobs older than 1 hour
    const oldFinishedJobs = await prisma.printJob.findMany({
      where: {
        status: { in: ['COMPLETED', 'FAILED', 'REFUNDED'] },
        updatedAt: { lt: oneHourAgo }
      },
      include: { document: true }
    });

    for (const job of oldFinishedJobs) {
      if (job.document && job.document.filename) {
        await deleteFile(job.document.filename);
        // Clear filename in DB so we don't try to delete it again
        await prisma.document.update({
          where: { id: job.document.id },
          data: { filename: null, originalName: 'File deleted (retention period ended)' }
        });
        console.log(`🧹 Deleted stale file for job ${job.shortId}.`);
      }
    }
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}, 15 * 60 * 1000);

if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

const _setQueueForTesting = (mockQueue, isRedis, io) => {
  printQueue = mockQueue;
  if (typeof isRedis === 'boolean') {
    useRedis = isRedis;
  }
  if (io !== undefined) {
    globalIo = io;
  }
};

module.exports = {
  processJob,
  startPrintingProcess,
  calculateEstimatedWaitTime,
  initWorker,
  cleanupAbandonedJobs,
  buildAbandonedJobWhere,
  hasProtectedJobReferences,
  cleanupStuckPrintingJobs,
  _setQueueForTesting
};
