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
    const dbJob = await prisma.printJob.findUnique({ 
      where: { shortId },
      include: { document: true }
    });
    if (!dbJob) return;

    // Validate state transition using state machine
    if (!isValidJobTransition(dbJob.status, 'PRINTING')) {
      console.warn(`Job ${shortId}: cannot transition from ${dbJob.status} to PRINTING, skipping`);
      return;
    }

    if (dbJob.status === 'WAITING') {
      const updatedJob = await prisma.printJob.update({
        where: { shortId },
        data: { status: 'PRINTING' },
        include: { document: true }
      });
      
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
          iv: updatedJob.iv
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
    }
  } catch(e) {
    console.error(`Error processing job ${shortId}:`, e);
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
  if (!globalIo && io) globalIo = io;
  
  if (useRedis && printQueue) {
    try {
      // Race with a 2.5s timeout so a dead/limited Redis never blocks printing
      await Promise.race([
        printQueue.add('printJob', { shortId }, {
          attempts: 1, // Single execution guarantee for physical printing (NO AUTOMATIC RETRIES)
          removeOnComplete: true,
          removeOnFail: false // Retain failed physical job records for operator inspection
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis operation timed out')), 2500))
      ]);
    } catch(e) {
      console.warn(`Redis queue unavailable (${e.message}), executing print job in-memory fallback.`);
      processJob(shortId);
    }
  } else {
    // In-memory fallback: just process asynchronously
    processJob(shortId);
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

// Cleanup abandoned jobs and stuck PRINTING jobs every 15 minutes
const cleanupTimer = setInterval(async () => {
  try {
    const oneHourAgo = new Date(Date.now() - ABANDONED_JOB_TTL_MS);
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60000);
    const { deleteFile } = require('../utils/storage');

    // 1. Delete genuinely abandoned unlinked PENDING_PAYMENT jobs safely
    await cleanupAbandonedJobs({ deleteFileFn: deleteFile });

    // 2. P3-004: Fail and refund stuck PRINTING jobs (Agent crash recovery)
    const stuckJobs = await prisma.printJob.findMany({
      where: {
        status: 'PRINTING',
        updatedAt: { lt: fifteenMinsAgo }
      }
    });

    for (const job of stuckJobs) {
      console.error(`⚠️  Job ${job.shortId} stuck in PRINTING for >15 mins. Marking FAILED.`);
      await prisma.printJob.update({
        where: { id: job.id },
        data: { status: 'FAILED' }
      });

      if (job.paymentId) {
        try {
          console.log(`Initiating automated recovery refund via refund.service for stuck job ${job.shortId}...`);
          const refundService = require('./refund.service');
          await refundService.createRefund({
            paymentId: job.paymentId,
            reason: 'Automated crash recovery refund: print job stuck in PRINTING for >15 minutes',
            idempotencyKey: `auto_recovery_${job.id}_${job.paymentId}`,
            initiatedBy: 'SYSTEM'
          });
        } catch (refundErr) {
          console.error(`Automated refund failed/skipped for stuck job ${job.shortId}:`, refundErr.message);
        }
      }
    }

    // 3. Delete files for COMPLETED, FAILED, and REFUNDED jobs older than 1 hour
    await cleanupExpiredJobFiles({ deleteFileFn: deleteFile });
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
  startPrintingProcess,
  calculateEstimatedWaitTime,
  initWorker,
  cleanupAbandonedJobs,
  cleanupExpiredJobFiles,
  buildAbandonedJobWhere,
  hasProtectedJobReferences
};
