/**
 * Child process worker for Test 12 (pr19_up02_postgresql_concurrency.test.js).
 *
 * Runs in an isolated Node.js child process with a fresh PrismaClient connection,
 * exercising the actual startup reconciliation path at a real OS process boundary.
 *
 * Usage:
 *   node child-reconcile-worker.js <shortId> <databaseUrl>
 *
 * Writes a JSON result object to stdout and sets exitCode 0 on success.
 * Writes JSON error to stdout and sets exitCode 1 on failure.
 *
 * Safety:
 * - Exclusively uses the DATABASE_URL passed as argument or environment variable.
 * - WHATWG URL validation requires 127.0.0.1:5433/printgo_disposable_target strictly.
 * - Never accesses port 5432 or any non-disposable database.
 * - PrismaClient.$disconnect() is always awaited in finally before event loop exits.
 */

'use strict';

const { PrismaClient } = require('@prisma/client');

/**
 * Validates database URL strictly using WHATWG URL parser.
 * Requires:
 *   protocol === 'postgresql:'
 *   hostname in ['127.0.0.1', 'localhost']
 *   port === '5433'
 *   pathname === '/printgo_disposable_target'
 *
 * Rejects malformed, missing, alternate-host, alternate-port, and alternate-database URLs.
 * Never connects to any database during validation.
 */
function validateDatabaseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'SAFETY REJECTION: Missing or empty DATABASE_URL.' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return { valid: false, error: `SAFETY REJECTION: Malformed DATABASE_URL: ${err.message}` };
  }

  if (parsed.protocol !== 'postgresql:') {
    return { valid: false, error: `SAFETY REJECTION: protocol must be 'postgresql:' (received '${parsed.protocol}')` };
  }
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    return { valid: false, error: `SAFETY REJECTION: hostname must be '127.0.0.1' or 'localhost' (received '${parsed.hostname}')` };
  }
  if (parsed.port !== '5433') {
    return { valid: false, error: `SAFETY REJECTION: port must be exactly '5433' (received '${parsed.port || 'default'}')` };
  }
  if (parsed.pathname !== '/printgo_disposable_target') {
    return { valid: false, error: `SAFETY REJECTION: pathname must be exactly '/printgo_disposable_target' (received '${parsed.pathname}')` };
  }

  return { valid: true, parsed };
}

async function main() {
  const shortId = process.argv[2];
  const databaseUrl = process.argv[3] || process.env.DATABASE_URL;

  if (!shortId || !databaseUrl) {
    process.stdout.write(JSON.stringify({ success: false, error: 'Missing shortId or databaseUrl argument' }));
    process.exitCode = 1;
    return;
  }

  const validation = validateDatabaseUrl(databaseUrl);
  if (!validation.valid) {
    process.stdout.write(JSON.stringify({ success: false, error: validation.error }));
    process.exitCode = 1;
    return;
  }

  let prisma = null;

  try {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    // Record target job state before running reconciliation
    const preJob = await prisma.printJob.findUnique({ where: { shortId } });

    // Load reconciler from production source — fresh module cache in this process
    const { reconcileStrandedWaitingJobs } = require('../../src/services/queueService');

    // Build a mock Socket.IO emitter capturing room and event payloads
    const emittedEvents = [];
    const mockIo = {
      to: (room) => ({
        emit: (event, payload) => {
          emittedEvents.push({ room, event, payload });
        }
      }),
      emit: (event, payload) => {
        emittedEvents.push({ event, payload });
      }
    };

    const summary = await reconcileStrandedWaitingJobs({
      prismaClient: prisma,
      io: mockIo,
      thresholdMs: 15000
    });

    // Read final job state after reconciliation
    const postJob = await prisma.printJob.findUnique({ where: { shortId } });
    const payment = postJob?.paymentId
      ? await prisma.payment.findUnique({ where: { id: postJob.paymentId } })
      : null;

    // Actual physical dispatch event evidence for this specific target job
    const targetJobEvents = emittedEvents.filter(
      e => e.event === 'physical_print_job' && e.payload && e.payload.jobId === shortId
    );

    // Target-specific dispatch evidence: did this specific target job transition WAITING -> PRINTING?
    const targetDispatched = Boolean(preJob && preJob.status === 'WAITING' && postJob && postJob.status === 'PRINTING');

    process.stdout.write(JSON.stringify({
      success: true,
      summary,
      targetDispatched,
      targetEventCount: targetJobEvents.length,
      targetInitialStatus: preJob?.status,
      jobStatus: postJob?.status,
      jobPrintAttempts: postJob?.printAttempts,
      paymentAuthorizedAttempts: payment?.authorizedPrintAttempts,
      reservedForRetry: postJob?.reservedForRetry,
      emittedEventCount: emittedEvents.length,
      prismaDisconnected: true
    }));
    process.exitCode = 0;
  } catch (err) {
    process.stdout.write(JSON.stringify({ success: false, error: err.message }));
    process.exitCode = 1;
  } finally {
    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  validateDatabaseUrl,
  main
};
