/**
 * Distributed Reconciliation Worker
 * WP-15.8I-D: Atomic Leases, Monotonic Fencing, Durable DISPATCH_INTENT & Ambiguous Outcome Recovery
 */

const crypto = require('crypto');
const prisma = require('../utils/prisma');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const cashfreeGateway = require('./cashfreeGateway.adapter');
const refundService = require('./refund.service');
const { issueCreditNoteForInvoice } = require('./invoice.service');
const { redactSensitiveData } = require('../config/cashfree.config');

class StaleLeaseError extends Error {
  constructor(message) {
    super(message || 'Lease renewal rejected: lease expired, workerId mismatched, or reclaimed by another worker');
    this.name = 'StaleLeaseError';
    this.code = 'STALE_LEASE';
  }
}

class StaleFencingTokenError extends Error {
  constructor(message) {
    super(message || 'Operation rejected: Fencing token or lease is stale.');
    this.name = 'StaleFencingTokenError';
    this.code = 'STALE_FENCING_TOKEN';
  }
}

class DispatchIntentError extends Error {
  constructor(message) {
    super(message || 'Failed to persist DISPATCH_INTENT: record is not in NOT_DISPATCHED state or lease/fencing token is stale');
    this.name = 'DispatchIntentError';
    this.code = 'DISPATCH_INTENT_ERROR';
  }
}

/**
 * Generates a unique worker ID with host PID and cryptographic entropy.
 */
function generateWorkerId(prefix = 'worker') {
  const nonce = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${process.pid}_${Date.now()}_${nonce}`;
}

/**
 * 3.1 Lease Acquisition
 * Atomically claims one eligible ReconciliationRecord using PostgreSQL's FOR UPDATE SKIP LOCKED
 * and database clock time (NOW()).
 * Increments fencingToken monotonically upon claim/reclamation.
 */
async function claimRecord(options = {}) {
  const {
    workerId = generateWorkerId(),
    leaseDurationMs = 30000,
    specificRecordId = null
  } = options;

  let query;
  let params;

  if (specificRecordId) {
    query = `
      WITH eligible AS (
        SELECT id
        FROM "ReconciliationRecord"
        WHERE id = $1
          AND resolved = false
          AND "dispatchState" NOT IN ('MANUAL_REVIEW_REQUIRED', 'GATEWAY_FAILED')
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < clock_timestamp())
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "ReconciliationRecord" rr
      SET "workerId" = $2,
          "leaseExpiresAt" = clock_timestamp() + ($3 || ' milliseconds')::INTERVAL,
          "fencingToken" = rr."fencingToken" + 1
      FROM eligible
      WHERE rr.id = eligible.id
      RETURNING rr.id, rr."paymentId", rr."refundId", rr."printJobId", rr.status,
                rr."discrepancyType", rr.details, rr.resolved, rr."workerId",
                rr."leaseExpiresAt", rr."fencingToken", rr."dispatchState", rr."createdAt";
    `;
    params = [specificRecordId, workerId, String(leaseDurationMs)];
  } else {
    query = `
      WITH eligible AS (
        SELECT id
        FROM "ReconciliationRecord"
        WHERE resolved = false
          AND "dispatchState" NOT IN ('MANUAL_REVIEW_REQUIRED', 'GATEWAY_FAILED')
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < clock_timestamp())
        ORDER BY "leaseExpiresAt" ASC NULLS FIRST, "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "ReconciliationRecord" rr
      SET "workerId" = $1,
          "leaseExpiresAt" = clock_timestamp() + ($2 || ' milliseconds')::INTERVAL,
          "fencingToken" = rr."fencingToken" + 1
      FROM eligible
      WHERE rr.id = eligible.id
      RETURNING rr.id, rr."paymentId", rr."refundId", rr."printJobId", rr.status,
                rr."discrepancyType", rr.details, rr.resolved, rr."workerId",
                rr."leaseExpiresAt", rr."fencingToken", rr."dispatchState", rr."createdAt";
    `;
    params = [workerId, String(leaseDurationMs)];
  }

  const rows = await prisma.$queryRawUnsafe(query, ...params);
  if (!rows || rows.length === 0) {
    return null;
  }

  const record = rows[0];
  logger.info(`[FencingWorker] Worker ${workerId} acquired lease on ReconciliationRecord ${record.id} (fencingToken: ${record.fencingToken}, state: ${record.dispatchState})`);
  return record;
}

/**
 * 3.2 Lease Renewal
 * Atomically extends the lease expiration if and only if the caller matches the current workerId,
 * the current fencingToken, and the existing lease has not already expired in database time.
 */
async function renewLease({ recordId, workerId, fencingToken, leaseDurationMs = 30000 }) {
  if (!recordId || !workerId || fencingToken === undefined || fencingToken === null) {
    throw new Error('recordId, workerId, and fencingToken are required for lease renewal');
  }

  const query = `
    UPDATE "ReconciliationRecord"
    SET "leaseExpiresAt" = clock_timestamp() + ($1 || ' milliseconds')::INTERVAL
    WHERE id = $2
      AND "workerId" = $3
      AND "fencingToken" = $4
      AND "leaseExpiresAt" > clock_timestamp()
    RETURNING id, "workerId", "fencingToken", "leaseExpiresAt";
  `;

  const rows = await prisma.$queryRawUnsafe(query, String(leaseDurationMs), recordId, workerId, BigInt(fencingToken));
  if (!rows || rows.length === 0) {
    logger.warn(`[FencingWorker] Lease renewal failed for worker ${workerId} on record ${recordId} (fencingToken: ${fencingToken}). Worker is stale or expired.`);
    throw new StaleLeaseError(`Lease renewal rejected for worker ${workerId} on record ${recordId}`);
  }

  return rows[0];
}

/**
 * 3.3 Fenced Mutation Helper
 * Executes an update strictly guarded by workerId, fencingToken, and active lease validity.
 */
async function fencedUpdate({ recordId, workerId, fencingToken, data = {}, whereExtra = '' }) {
  if (!recordId || !workerId || fencingToken === undefined || fencingToken === null) {
    throw new Error('recordId, workerId, and fencingToken are required for fenced updates');
  }

  const setClauses = [];
  const params = [recordId, workerId, BigInt(fencingToken)];
  let paramIdx = 4;

  for (const [key, val] of Object.entries(data)) {
    setClauses.push(`"${key}" = $${paramIdx}`);
    params.push(val);
    paramIdx++;
  }

  if (setClauses.length === 0) {
    return null;
  }

  const query = `
    UPDATE "ReconciliationRecord"
    SET ${setClauses.join(', ')}
    WHERE id = $1
      AND "workerId" = $2
      AND "fencingToken" = $3
      AND "leaseExpiresAt" > clock_timestamp()
      ${whereExtra ? `AND (${whereExtra})` : ''}
    RETURNING *;
  `;

  const rows = await prisma.$queryRawUnsafe(query, ...params);
  if (!rows || rows.length === 0) {
    logger.error(`[FencingWorker] Fenced update rejected on record ${recordId}. Stale token ${fencingToken} or lease expired.`);
    throw new StaleFencingTokenError(`Fenced update rejected on record ${recordId}`);
  }

  return rows[0];
}

/**
 * Phase 3 — Durable DISPATCH_INTENT Barrier
 * Atomically transitions state from NOT_DISPATCHED to DISPATCH_INTENT in a short transaction
 * that commits BEFORE the external gateway request is dispatched.
 */
async function persistDispatchIntent({ recordId, workerId, fencingToken }) {
  if (!recordId || !workerId || fencingToken === undefined || fencingToken === null) {
    throw new Error('recordId, workerId, and fencingToken are required for persistDispatchIntent');
  }

  const query = `
    UPDATE "ReconciliationRecord"
    SET "dispatchState" = 'DISPATCH_INTENT'
    WHERE id = $1
      AND "workerId" = $2
      AND "fencingToken" = $3
      AND "dispatchState" = 'NOT_DISPATCHED'
      AND "leaseExpiresAt" > clock_timestamp()
    RETURNING id, "dispatchState", "fencingToken", "workerId";
  `;

  const rows = await prisma.$queryRawUnsafe(query, recordId, workerId, BigInt(fencingToken));
  if (!rows || rows.length === 0) {
    throw new DispatchIntentError(`Failed to persist DISPATCH_INTENT on record ${recordId}: record is not in NOT_DISPATCHED state or lease is stale`);
  }

  logger.info(`[FencingWorker] Durable DISPATCH_INTENT committed for record ${recordId} (token: ${fencingToken})`);
  return rows[0];
}

/**
 * Phase 4 — Cashfree Ambiguous Outcome Inquiry Recovery
 * When a record is claimed in DISPATCH_INTENT or OUTCOME_UNKNOWN, the worker MUST NOT re-dispatch.
 * It executes gateway inquiry using getRefundDetails() and reconciles based on gateway authoritative outcome.
 */
async function inquireAndRecoverRecord(record, options = {}) {
  const { workerId, fencingToken } = options;

  logger.info(`[FencingWorker] Initiating inquiry recovery for record ${record.id} (state: ${record.dispatchState}, token: ${fencingToken})`);

  let refund = null;
  let payment = null;

  if (record.refundId) {
    refund = await prisma.refund.findUnique({
      where: { id: record.refundId },
      include: {
        payment: {
          include: { printJobs: { include: { invoice: true } } }
        }
      }
    });
    payment = refund?.payment;
  } else if (record.paymentId) {
    payment = await prisma.payment.findUnique({
      where: { id: record.paymentId },
      include: {
        refunds: { orderBy: { createdAt: 'desc' } },
        printJobs: { include: { invoice: true } }
      }
    });
    refund = payment?.refunds?.[0] || null;
  }

  if (!payment || !payment.gatewayOrderId || !refund || !refund.gatewayRefundId) {
    logger.warn(`[FencingWorker] Insufficient gateway identity to perform inquiry for record ${record.id}. Escalating to MANUAL_REVIEW_REQUIRED.`);
    return await fencedUpdate({
      recordId: record.id,
      workerId,
      fencingToken,
      data: {
        dispatchState: 'MANUAL_REVIEW_REQUIRED',
        resolutionNotes: 'Missing gatewayOrderId or gatewayRefundId required for automated inquiry recovery'
      }
    });
  }

  // Perform safe read-only gateway inquiry
  let gwInquiry;
  try {
    gwInquiry = await cashfreeGateway.getRefundDetails(payment.gatewayOrderId, refund.gatewayRefundId);
  } catch (err) {
    logger.error(`[FencingWorker] Gateway inquiry threw exception for record ${record.id}: ${err.message}`);
    gwInquiry = { success: false, status: 'UNKNOWN', isTimeout: true, error: err.message };
  }

  const rawStatus = (gwInquiry?.status || '').toUpperCase();
  logger.info(`[FencingWorker] Gateway inquiry outcome for record ${record.id}: rawStatus=${rawStatus}, success=${gwInquiry?.success}`);

  // 1. CONFIRMED SUCCESS
  if (gwInquiry.success && rawStatus === 'SUCCESS') {
    // Finalize state in fenced update
    await fencedUpdate({
      recordId: record.id,
      workerId,
      fencingToken,
      data: {
        dispatchState: 'GATEWAY_CONFIRMED',
        resolved: true,
        resolvedAt: new Date(),
        resolvedBy: workerId,
        resolutionNotes: `Reconciled successfully via gateway inquiry confirmation (cf_refund_id: ${gwInquiry.cfRefundId || refund.gatewayRefundId})`
      }
    });

    // Update local Refund record
    await prisma.refund.update({
      where: { id: refund.id },
      data: {
        status: 'SUCCESS',
        cfRefundId: gwInquiry.cfRefundId || refund.cfRefundId,
        gatewayResponse: redactSensitiveData(gwInquiry.rawResponse),
        processedAt: new Date()
      }
    }).catch(() => {});

    // Check Credit Note issuance
    const jobWithInvoice = payment.printJobs?.find(j => j.invoice);
    if (jobWithInvoice && jobWithInvoice.invoice) {
      await issueCreditNoteForInvoice(jobWithInvoice.invoice.id, {
        refundId: refund.id,
        amount: refund.amount,
        reason: 'Reconciled via gateway inquiry confirmation'
      }).catch((cnErr) => {
        logger.warn(`[FencingWorker] Statutory credit note issuance note: ${cnErr.message}`);
      });
    }

    return { recovered: true, dispatchState: 'GATEWAY_CONFIRMED', outcome: 'SUCCESS' };
  }

  // 2. DEFINITIVE FAILURE AT GATEWAY
  if (rawStatus === 'FAILED' || rawStatus === 'CANCELLED') {
    await fencedUpdate({
      recordId: record.id,
      workerId,
      fencingToken,
      data: {
        dispatchState: 'GATEWAY_FAILED',
        resolved: false,
        resolutionNotes: `Gateway definitively rejected refund: ${gwInquiry.error || 'Gateway FAILED/CANCELLED'}`
      }
    });

    await prisma.refund.update({
      where: { id: refund.id },
      data: {
        status: 'FAILED',
        failureReason: gwInquiry.error || 'Gateway rejected refund during inquiry verification',
        retryEligible: true
      }
    }).catch(() => {});

    return { recovered: true, dispatchState: 'GATEWAY_FAILED', outcome: 'FAILED' };
  }

  // 3. REFUND NOT FOUND (404) AT GATEWAY
  if (gwInquiry.isNotFound || rawStatus === 'NOT_FOUND') {
    // If the record was in DISPATCH_INTENT and gateway has no record,
    // the request never reached gateway. We quarantine to MANUAL_REVIEW_REQUIRED to prevent any duplicate dispatch.
    await fencedUpdate({
      recordId: record.id,
      workerId,
      fencingToken,
      data: {
        dispatchState: 'MANUAL_REVIEW_REQUIRED',
        resolutionNotes: 'Gateway returned 404 Not Found for intent-marked refund. Quarantined for operator review.'
      }
    });
    return { recovered: true, dispatchState: 'MANUAL_REVIEW_REQUIRED', outcome: 'NOT_FOUND' };
  }

  // 4. IN-FLIGHT PROCESSING OR TIMEOUT / INCONCLUSIVE
  // Invariant: NEVER retry. Retain OUTCOME_UNKNOWN for future inquiry cycles.
  await fencedUpdate({
    recordId: record.id,
    workerId,
    fencingToken,
    data: {
      dispatchState: 'OUTCOME_UNKNOWN',
      resolutionNotes: `Inquiry inconclusive (status: ${rawStatus || 'TIMEOUT'}). Retained in OUTCOME_UNKNOWN.`
    }
  });

  return { recovered: false, dispatchState: 'OUTCOME_UNKNOWN', outcome: rawStatus || 'INCONCLUSIVE' };
}

/**
 * Executes a complete processing cycle for a single claimed ReconciliationRecord.
 */
async function processRecord(record, options = {}) {
  const {
    workerId = record.workerId,
    fencingToken = record.fencingToken,
    leaseDurationMs = 30000
  } = options;

  logger.info(`[FencingWorker] Processing record ${record.id} under worker ${workerId} (token: ${fencingToken}, state: ${record.dispatchState})`);

  // Path 1: Record already in DISPATCH_INTENT or OUTCOME_UNKNOWN (or discrepancy is ambiguous) -> Strictly Inquiry Recovery
  if (
    record.dispatchState === 'DISPATCH_INTENT' ||
    record.dispatchState === 'OUTCOME_UNKNOWN' ||
    record.discrepancyType === 'AMBIGUOUS_GATEWAY_OUTCOME'
  ) {
    return await inquireAndRecoverRecord(record, { workerId, fencingToken });
  }

  // Path 2: Record already confirmed at gateway but not marked resolved
  if (record.dispatchState === 'GATEWAY_CONFIRMED') {
    if (!record.resolved) {
      await fencedUpdate({
        recordId: record.id,
        workerId,
        fencingToken,
        data: {
          resolved: true,
          resolvedAt: new Date(),
          resolvedBy: workerId,
          resolutionNotes: 'Marked resolved following confirmed gateway state verification'
        }
      });
    }
    return { recovered: true, dispatchState: 'GATEWAY_CONFIRMED' };
  }

  // Path 3: Record in NOT_DISPATCHED -> Durable Intent Barrier followed by Dispatch
  if (record.dispatchState === 'NOT_DISPATCHED') {
    // 1. Persist DISPATCH_INTENT in short committed transaction
    await persistDispatchIntent({
      recordId: record.id,
      workerId,
      fencingToken
    });

    // 2. Resolve Payment and Job identity
    let payment = null;
    let targetJob = null;

    if (record.paymentId) {
      payment = await prisma.payment.findUnique({
        where: { id: record.paymentId },
        include: { printJobs: true }
      });
      if (record.printJobId) {
        targetJob = payment?.printJobs?.find(j => j.id === record.printJobId);
      } else if (payment?.printJobs?.length === 1) {
        targetJob = payment.printJobs[0];
      }
    }

    if (!payment) {
      await fencedUpdate({
        recordId: record.id,
        workerId,
        fencingToken,
        data: {
          dispatchState: 'MANUAL_REVIEW_REQUIRED',
          resolutionNotes: 'Cannot dispatch refund: associated Payment record not found'
        }
      });
      return { dispatchState: 'MANUAL_REVIEW_REQUIRED' };
    }

    // 3. Dispatch refund via refundService with strict idempotency and per-job cap
    let refundResult;
    try {
      refundResult = await refundService.createRefund({
        paymentId: payment.id,
        printJobId: targetJob ? targetJob.id : undefined,
        amount: targetJob ? targetJob.cost : payment.amount,
        idempotencyKey: `rec_worker_dispatch_${record.id}`,
        reason: `Automated reconciliation refund for record ${record.id}`,
        initiatedBy: workerId
      });
    } catch (dispatchErr) {
      logger.error(`[FencingWorker] Refund dispatch failed for record ${record.id}: ${dispatchErr.message}`);

      // If dispatch failed before gateway call, check if error was timeout or conflict
      const isTimeout = dispatchErr.message?.includes('timeout') || dispatchErr.code === 'ECONNABORTED';
      const finalState = isTimeout ? 'OUTCOME_UNKNOWN' : 'GATEWAY_FAILED';

      await fencedUpdate({
        recordId: record.id,
        workerId,
        fencingToken,
        data: {
          dispatchState: finalState,
          resolutionNotes: `Refund dispatch returned: ${dispatchErr.message}`
        }
      });
      return { dispatchState: finalState, error: dispatchErr.message };
    }

    // 4. Finalize state based on refund outcome
    const isSuccess = refundResult.status === 'SUCCESS';
    const isProcessing = refundResult.status === 'PROCESSING';

    const nextState = isSuccess ? 'GATEWAY_CONFIRMED' : (isProcessing ? 'OUTCOME_UNKNOWN' : 'GATEWAY_FAILED');

    await fencedUpdate({
      recordId: record.id,
      workerId,
      fencingToken,
      data: {
        refundId: refundResult.id,
        dispatchState: nextState,
        resolved: isSuccess,
        resolvedAt: isSuccess ? new Date() : null,
        resolvedBy: isSuccess ? workerId : null,
        resolutionNotes: `Refund dispatch completed with status ${refundResult.status}`
      }
    });

    return { dispatchState: nextState, refundId: refundResult.id };
  }

  return { dispatchState: record.dispatchState };
}

/**
 * Runs a single worker batch execution up to maxRecords.
 */
async function runWorkerBatch(options = {}) {
  const {
    workerId = generateWorkerId(),
    maxRecords = 5,
    leaseDurationMs = 30000
  } = options;

  const results = [];

  for (let i = 0; i < maxRecords; i++) {
    const record = await claimRecord({ workerId, leaseDurationMs });
    if (!record) {
      break; // No more eligible records to process
    }

    try {
      const result = await processRecord(record, {
        workerId,
        fencingToken: record.fencingToken,
        leaseDurationMs
      });
      results.push({ recordId: record.id, success: true, ...result });
    } catch (err) {
      logger.error(`[FencingWorker] Exception while processing record ${record.id}: ${err.message}`);
      results.push({ recordId: record.id, success: false, error: err.message, code: err.code });
    }
  }

  return {
    workerId,
    processedCount: results.length,
    results
  };
}

// --- Worker Operational Lifecycle State ---
let workerLoopState = {
  isLoopRunning: false,
  isShuttingDown: false,
  isBatchInProgress: false,
  currentBatchPromise: null,
  loopTimer: null,
  workerId: null,
  consecutiveFailures: 0,
  lastRunStartedAt: null,
  lastRunCompletedAt: null,
  lastError: null,
  totalBatchesProcessed: 0,
  totalRecordsProcessed: 0
};

/**
 * Starts the reconciliation worker periodic loop in this process.
 * Singleton: if already running, returns existing status.
 */
async function startReconciliationWorkerLoop(options = {}) {
  const {
    pollIntervalMs = parseInt(process.env.RECONCILIATION_POLL_INTERVAL_MS, 10) || 60000,
    batchSize = parseInt(process.env.RECONCILIATION_BATCH_SIZE, 10) || 10,
    leaseDurationMs = parseInt(process.env.RECONCILIATION_LEASE_MS, 10) || 30000,
    workerId = generateWorkerId('srv_rec'),
    initialDelayMs = 5000,
    runImmediately = false
  } = options;

  if (workerLoopState.isLoopRunning) {
    logger.warn(`[ReconciliationWorkerLoop] Worker loop already running (workerId: ${workerLoopState.workerId}). Ignoring duplicate start.`);
    return getReconciliationWorkerHealth();
  }

  workerLoopState = {
    isLoopRunning: true,
    isShuttingDown: false,
    isBatchInProgress: false,
    currentBatchPromise: null,
    loopTimer: null,
    workerId,
    consecutiveFailures: 0,
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    lastError: null,
    totalBatchesProcessed: 0,
    totalRecordsProcessed: 0
  };

  logger.info(`[ReconciliationWorkerLoop] Initializing loop (workerId: ${workerId}, interval: ${pollIntervalMs}ms, batchSize: ${batchSize})`);

  async function tick() {
    if (!workerLoopState.isLoopRunning || workerLoopState.isShuttingDown) {
      return;
    }

    if (workerLoopState.isBatchInProgress) {
      logger.warn(`[ReconciliationWorkerLoop] Previous batch still in progress; skipping tick.`);
      return;
    }

    workerLoopState.isBatchInProgress = true;
    workerLoopState.lastRunStartedAt = new Date();

    const batchPromise = (async () => {
      try {
        const batchOutcome = await runWorkerBatch({
          workerId: workerLoopState.workerId,
          maxRecords: batchSize,
          leaseDurationMs
        });
        workerLoopState.lastRunCompletedAt = new Date();
        workerLoopState.consecutiveFailures = 0;
        workerLoopState.lastError = null;
        workerLoopState.totalBatchesProcessed++;
        workerLoopState.totalRecordsProcessed += (batchOutcome.processedCount || 0);
        return batchOutcome;
      } catch (err) {
        workerLoopState.consecutiveFailures++;
        workerLoopState.lastError = err.message;
        logger.error(`[ReconciliationWorkerLoop] Error during batch processing: ${err.message}`);
        throw err;
      } finally {
        workerLoopState.isBatchInProgress = false;
        workerLoopState.currentBatchPromise = null;
        if (workerLoopState.isLoopRunning && !workerLoopState.isShuttingDown) {
          workerLoopState.loopTimer = setTimeout(tick, pollIntervalMs);
          workerLoopState.loopTimer.unref();
        }
      }
    })();

    workerLoopState.currentBatchPromise = batchPromise;
    try {
      await batchPromise;
    } catch {
      // Handled in batchPromise catch
    }
  }

  if (runImmediately) {
    tick().catch(() => {});
  } else {
    workerLoopState.loopTimer = setTimeout(tick, initialDelayMs);
    workerLoopState.loopTimer.unref();
  }

  return getReconciliationWorkerHealth();
}

/**
 * Stops the reconciliation worker loop gracefully.
 * Stops accepting new batches and allows in-flight batch to drain within timeoutMs.
 * Does not mutate active database leases (they expire naturally).
 */
async function stopReconciliationWorkerLoop(options = {}) {
  const { timeoutMs = 15000 } = options;

  if (!workerLoopState.isLoopRunning && !workerLoopState.isBatchInProgress) {
    return { stopped: true };
  }

  logger.info(`[ReconciliationWorkerLoop] Gracefully stopping loop (workerId: ${workerLoopState.workerId})`);
  workerLoopState.isShuttingDown = true;
  workerLoopState.isLoopRunning = false;

  if (workerLoopState.loopTimer) {
    clearTimeout(workerLoopState.loopTimer);
    workerLoopState.loopTimer = null;
  }

  if (workerLoopState.isBatchInProgress && workerLoopState.currentBatchPromise) {
    logger.info(`[ReconciliationWorkerLoop] Waiting up to ${timeoutMs}ms for in-flight batch to complete...`);
    await Promise.race([
      workerLoopState.currentBatchPromise.catch(() => {}),
      new Promise(resolve => setTimeout(resolve, timeoutMs))
    ]);
  }

  workerLoopState.isBatchInProgress = false;
  workerLoopState.currentBatchPromise = null;
  workerLoopState.isShuttingDown = false;
  workerLoopState.isLoopRunning = false;
  logger.info(`[ReconciliationWorkerLoop] Stopped cleanly.`);
  return { stopped: true };
}

/**
 * Returns worker health status for readiness probes.
 * Distinguishes:
 * - 'disabled': loop is not started.
 * - 'starting': loop is running but has not yet completed a run.
 * - 'healthy': running and consecutive failures < 3.
 * - 'degraded': running but consecutive failures >= 3.
 */
function getReconciliationWorkerHealth() {
  if (!workerLoopState.isLoopRunning && !workerLoopState.isShuttingDown) {
    return {
      enabled: false,
      status: 'disabled',
      ready: true
    };
  }

  if (workerLoopState.isShuttingDown) {
    return {
      enabled: true,
      status: 'shutting_down',
      ready: false
    };
  }

  if (!workerLoopState.lastRunCompletedAt && !workerLoopState.lastError) {
    return {
      enabled: true,
      status: 'starting',
      ready: false,
      workerId: workerLoopState.workerId
    };
  }

  const isHealthy = workerLoopState.consecutiveFailures < 3;
  return {
    enabled: true,
    status: isHealthy ? 'healthy' : 'degraded',
    ready: isHealthy,
    workerId: workerLoopState.workerId,
    consecutiveFailures: workerLoopState.consecutiveFailures,
    lastRunStartedAt: workerLoopState.lastRunStartedAt,
    lastRunCompletedAt: workerLoopState.lastRunCompletedAt,
    lastError: workerLoopState.lastError,
    totalBatchesProcessed: workerLoopState.totalBatchesProcessed,
    totalRecordsProcessed: workerLoopState.totalRecordsProcessed
  };
}

module.exports = {
  claimRecord,
  renewLease,
  fencedUpdate,
  persistDispatchIntent,
  inquireAndRecoverRecord,
  processRecord,
  runWorkerBatch,
  startReconciliationWorkerLoop,
  stopReconciliationWorkerLoop,
  getReconciliationWorkerHealth,
  generateWorkerId,
  StaleLeaseError,
  StaleFencingTokenError,
  DispatchIntentError
};
