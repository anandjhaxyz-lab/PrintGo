/**
 * PRINTGO — UP-02 POSTGRESQL TRANSACTION-WIDE CONCURRENCY INTEGRATION TEST
 *
 * Mandatory Safety Rules:
 * 1. Target database MUST be localhost:5433/printgo_disposable_target.
 * 2. Port 5432 and non-disposable databases are STRICTLY PROHIBITED.
 * 3. Real PostgreSQL row-level locks and transaction serialization are verified.
 */

const { PrismaClient } = require('@prisma/client');
const net = require('net');
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const { validateDatabaseUrl } = require('./helpers/child-reconcile-worker');

let mockCurrentUser = {
  id: 'super-01',
  role: 'SUPERADMIN',
  email: 'super@printgo.test'
};

jest.mock('../src/middlewares/auth', () => ({
  protect: (req, res, next) => {
    req.user = mockCurrentUser;
    next();
  },
  restrictTo: (...roles) => (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  }
}));

jest.mock('../src/middlewares/readOnlyGuard', () => ({
  readOnlyGuard: (req, res, next) => next()
}));

jest.mock('../src/services/cashfreeGateway.adapter', () => ({
  createRefund: jest.fn().mockResolvedValue({
    success: true,
    status: 'SUCCESS',
    cfRefundId: 'cf_ref_mock_disposable',
    processedAt: new Date().toISOString()
  }),
  getRefundStatus: jest.fn().mockResolvedValue({
    success: true,
    status: 'SUCCESS'
  })
}));

const adminRoutes = require('../src/modules/admin/admin.routes');
const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);
app.use((err, req, res, next) => {
  const status = err.statusCode || (typeof err.status === 'number' ? err.status : 500);
  res.status(status).json({ success: false, error: err.message, code: err.code });
});

function genShortId(prefix = 'j') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres@127.0.0.1:5433/printgo_disposable_target?schema=public';
process.env.DATABASE_URL = DATABASE_URL;

function checkPortAvailability(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isConnected = false;

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      isConnected = true;
      socket.destroy();
      resolve(true);
    });

    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.once('error', () => {
      resolve(false);
    });

    socket.connect(port, host);
  });
}

function enforceSafety() {
  let parsed;
  try {
    parsed = new URL(DATABASE_URL);
  } catch (err) {
    throw new Error('SAFETY REJECTION: DATABASE_URL is malformed.');
  }

  const isLocalhost = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  const isDisposableTarget = isLocalhost && dbName === 'printgo_disposable_target' && parsed.port === '5433';

  if (!isDisposableTarget) {
    throw new Error(
      `SAFETY REJECTION: Integration tests strictly require the local disposable database on port 5433. ` +
      `Target was: ${parsed.hostname}:${parsed.port}/${dbName}. Refusing execution to protect other databases.`
    );
  }
}

describe('UP-02: PostgreSQL Transaction-Wide Sibling Concurrency & Attempt Ceiling', () => {
  jest.setTimeout(25000);
  let isPort5433Available = false;
  let prisma = null;
  let defaultDoc = null;

  beforeAll(async () => {
    enforceSafety();
    isPort5433Available = await checkPortAvailability('127.0.0.1', 5433);
    if (isPort5433Available) {
      prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
      // Create test superadmin user
      await prisma.user.upsert({
        where: { id: 'super-01' },
        update: {},
        create: {
          id: 'super-01',
          name: 'Super Admin',
          email: 'super@printgo.test',
          password: 'hashed-password-test',
          role: 'SUPERADMIN'
        }
      });
      // Create shared test document
      defaultDoc = await prisma.document.create({
        data: {
          originalName: 'test-print.pdf',
          filename: 'test-print.pdf',
          mimetype: 'application/pdf',
          size: 1024,
          pages: 1
        }
      });
    } else {
      console.warn(
        '\n⚠️  [ENVIRONMENT BLOCKER] Disposable PostgreSQL endpoint localhost:5433 is offline.\n' +
        '   PostgreSQL integration concurrency tests are safely skipped until the disposable container on port 5433 is running.\n'
      );
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  test('1. Integration preflight: Verify safety guards and port 5433 restriction', () => {
    expect(() => enforceSafety()).not.toThrow();
    expect(isPort5433Available).toBe(true);
  });

  test('2. Concurrent sibling reservations serialize at PostgreSQL Payment row level', async () => {
    if (!isPort5433Available) return;

    const queueService = require('../src/services/queueService');
    const paymentId = `pay-concurr-${Date.now()}`;

    // Initial state: Payment has 2 authorized attempts consumed (1 attempt remaining out of 3)
    await prisma.payment.create({
      data: {
        id: paymentId,
        amount: 50,
        status: 'SUCCESS',
        type: 'DEMO',
        authorizedPrintAttempts: 2,
        legacyAttemptsUnknown: false
      }
    });

    const shortId1 = genShortId('sib1');
    const shortId2 = genShortId('sib2');

    // Two sibling jobs, each has 1 historical attempt
    await prisma.printJob.create({
      data: {
        shortId: shortId1,
        documentId: defaultDoc.id,
        status: 'WAITING',
        paymentId,
        printAttempts: 1,
        legacyAttemptsUnknown: false,
        cost: 25,
        color: 'bw',
        duplex: 'single',
        copies: 1,
        pagesToPrint: 1
      }
    });

    await prisma.printJob.create({
      data: {
        shortId: shortId2,
        documentId: defaultDoc.id,
        status: 'WAITING',
        paymentId,
        printAttempts: 1,
        legacyAttemptsUnknown: false,
        cost: 25,
        color: 'bw',
        duplex: 'single',
        copies: 1,
        pagesToPrint: 1
      }
    });

    // Launch two concurrent dispatch reservation requests
    const [res1, res2] = await Promise.all([
      queueService.processJob(shortId1),
      queueService.processJob(shortId2)
    ]);

    // Exactly one reservation must succeed, and the other must be rejected
    const successes = [res1, res2].filter((r) => r && r.success === true);
    const rejections = [res1, res2].filter((r) => r && r.code === 'MAX_PRINT_ATTEMPTS_EXCEEDED');

    expect(successes.length).toBe(1);
    expect(rejections.length).toBe(1);
    expect(rejections[0].attempts).toBe(3);
    expect(rejections[0].maxAttempts).toBe(3);

    // Authoritative check in PostgreSQL:
    // Payment.authorizedPrintAttempts MUST equal exactly 3, NEVER 4
    const finalPayment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { authorizedPrintAttempts: true }
    });
    expect(finalPayment.authorizedPrintAttempts).toBe(3);

    // Sum of sibling printAttempts in PostgreSQL must agree with authoritative payment counter (2 + 1 = 3)
    const siblings = await prisma.printJob.findMany({
      where: { paymentId },
      select: { shortId: true, status: true, printAttempts: true }
    });
    const totalJobAttempts = siblings.reduce((sum, j) => sum + j.printAttempts, 0);
    expect(totalJobAttempts).toBe(3);

    const winningJob = siblings.find((j) => j.status === 'PRINTING');
    const losingJob = siblings.find((j) => j.status === 'WAITING');
    expect(winningJob).toBeDefined();
    expect(winningJob.printAttempts).toBe(2);
    expect(losingJob).toBeDefined();
    expect(losingJob.printAttempts).toBe(1);
  });

  test('3. Sibling jobs cannot reserve attempt 4 after transaction cap is reached', async () => {
    if (!isPort5433Available) return;

    const queueService = require('../src/services/queueService');
    const paymentId = `pay-exhausted-${Date.now()}`;

    await prisma.payment.create({
      data: {
        id: paymentId,
        amount: 30,
        status: 'SUCCESS',
        type: 'DEMO',
        authorizedPrintAttempts: 3,
        legacyAttemptsUnknown: false
      }
    });

    const shortId = genShortId('exh');
    await prisma.printJob.create({
      data: {
        shortId,
        documentId: defaultDoc.id,
        status: 'WAITING',
        paymentId,
        printAttempts: 1,
        legacyAttemptsUnknown: false,
        cost: 30
      }
    });

    const res = await queueService.processJob(shortId);
    expect(res.success).toBe(false);
    expect(res.code).toBe('MAX_PRINT_ATTEMPTS_EXCEEDED');
    expect(res.attempts).toBe(3);

    // Ensure database was not modified
    const dbJob = await prisma.printJob.findUnique({ where: { shortId } });
    expect(dbJob.status).toBe('WAITING');
    expect(dbJob.printAttempts).toBe(1);

    const dbPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(dbPayment.authorizedPrintAttempts).toBe(3);
  });

  test('4. Transaction rollback when PrintJob state claim fails (preserves payment budget)', async () => {
    if (!isPort5433Available) return;

    const queueService = require('../src/services/queueService');
    const paymentId = `pay-rollback-${Date.now()}`;

    await prisma.payment.create({
      data: {
        id: paymentId,
        amount: 20,
        status: 'SUCCESS',
        type: 'DEMO',
        authorizedPrintAttempts: 1,
        legacyAttemptsUnknown: false
      }
    });

    const shortId = genShortId('rb');
    // Job is in COMPLETED (not eligible for WAITING -> PRINTING transition)
    await prisma.printJob.create({
      data: {
        shortId,
        documentId: defaultDoc.id,
        status: 'COMPLETED',
        paymentId,
        printAttempts: 1,
        legacyAttemptsUnknown: false,
        cost: 20
      }
    });

    const res = await queueService.processJob(shortId);
    expect(res.success).toBe(false);

    // Payment authorizedPrintAttempts must NOT have been incremented (remains 1)
    const dbPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(dbPayment.authorizedPrintAttempts).toBe(1);
  });

  test('5. Standalone job with null paymentId enforces 3-attempt ceiling', async () => {
    if (!isPort5433Available) return;

    const queueService = require('../src/services/queueService');
    const shortId = genShortId('nullp');

    await prisma.printJob.create({
      data: {
        shortId,
        documentId: defaultDoc.id,
        status: 'WAITING',
        paymentId: null,
        printAttempts: 2,
        legacyAttemptsUnknown: false,
        cost: 15
      }
    });

    // Claim 3rd attempt
    const res1 = await queueService.processJob(shortId);
    expect(res1.success).toBe(true);
    expect(res1.attempts).toBe(3);

    // Reset status to WAITING to simulate retry attempt 4
    await prisma.printJob.update({
      where: { shortId },
      data: { status: 'WAITING' }
    });

    // Attempt 4 must be rejected
    const res2 = await queueService.processJob(shortId);
    expect(res2.success).toBe(false);
    expect(res2.code).toBe('MAX_PRINT_ATTEMPTS_EXCEEDED');
    expect(res2.attempts).toBe(3);

    const dbJob = await prisma.printJob.findUnique({ where: { shortId } });
    expect(dbJob.printAttempts).toBe(3);
  });

  test('6. Legacy transactions with legacyAttemptsUnknown: true fail closed', async () => {
    if (!isPort5433Available) return;

    const queueService = require('../src/services/queueService');
    const shortId = genShortId('legunk');

    await prisma.printJob.create({
      data: {
        shortId,
        documentId: defaultDoc.id,
        status: 'WAITING',
        paymentId: null,
        printAttempts: 0,
        legacyAttemptsUnknown: true,
        cost: 10
      }
    });

    const res = await queueService.processJob(shortId);
    expect(res.success).toBe(false);
    expect(res.code).toBe('LEGACY_ATTEMPTS_EXHAUSTED');
  });

  test('7. Duplicate queue delivery while in PRINTING does not double-increment', async () => {
    if (!isPort5433Available) return;

    const queueService = require('../src/services/queueService');
    const paymentId = `pay-dup-${Date.now()}`;

    await prisma.payment.create({
      data: {
        id: paymentId,
        amount: 20,
        status: 'SUCCESS',
        type: 'DEMO',
        authorizedPrintAttempts: 0,
        legacyAttemptsUnknown: false
      }
    });

    const shortId = genShortId('dup');
    await prisma.printJob.create({
      data: {
        shortId,
        documentId: defaultDoc.id,
        status: 'WAITING',
        paymentId,
        printAttempts: 0,
        legacyAttemptsUnknown: false,
        cost: 20
      }
    });

    // 1st delivery
    const res1 = await queueService.processJob(shortId);
    expect(res1.success).toBe(true);
    expect(res1.attempts).toBe(1);

    // 2nd delivery while PRINTING
    const res2 = await queueService.processJob(shortId);
    expect(res2.success).toBe(false);

    const dbPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    const dbJob = await prisma.printJob.findUnique({ where: { shortId } });
    expect(dbPayment.authorizedPrintAttempts).toBe(1);
    expect(dbJob.printAttempts).toBe(1);
  });

  test('8. Real PostgreSQL Concurrency: Concurrent admin retry requests on sibling jobs never exceed 3 attempts in PostgreSQL', async () => {
    if (!isPort5433Available) return;

    const paymentId = `pay-admin-concurr-${Date.now()}`;

    // Payment in PostgreSQL with 2 authorized attempts consumed
    await prisma.payment.create({
      data: {
        id: paymentId,
        amount: 60,
        status: 'SUCCESS',
        type: 'DEMO',
        authorizedPrintAttempts: 2,
        legacyAttemptsUnknown: false
      }
    });

    const shortId1 = genShortId('adm_sib1');
    const shortId2 = genShortId('adm_sib2');
    const shortId3 = genShortId('adm_sib3');

    // Sibling 1 (FAILED, 1 attempt)
    await prisma.printJob.create({
      data: {
        shortId: shortId1,
        documentId: defaultDoc.id,
        status: 'FAILED',
        paymentId,
        printAttempts: 1,
        legacyAttemptsUnknown: false,
        cost: 20
      }
    });

    // Sibling 2 (FAILED, 1 attempt)
    await prisma.printJob.create({
      data: {
        shortId: shortId2,
        documentId: defaultDoc.id,
        status: 'FAILED',
        paymentId,
        printAttempts: 1,
        legacyAttemptsUnknown: false,
        cost: 20
      }
    });

    // Sibling 3 (FAILED, 0 attempts)
    await prisma.printJob.create({
      data: {
        shortId: shortId3,
        documentId: defaultDoc.id,
        status: 'FAILED',
        paymentId,
        printAttempts: 0,
        legacyAttemptsUnknown: false,
        cost: 20
      }
    });

    // Launch 3 concurrent admin retry requests via supertest
    const reason = 'Operator cleared physical paper jam in tray 1, authorizing retry';
    const [res1, res2, res3] = await Promise.all([
      request(app).post('/api/admin/dispatch-job').send({ shortId: shortId1, reason }),
      request(app).post('/api/admin/dispatch-job').send({ shortId: shortId2, reason }),
      request(app).post('/api/admin/dispatch-job').send({ shortId: shortId3, reason })
    ]);

    const successes = [res1, res2, res3].filter((r) => r.status === 200 && r.body.success === true);
    const rejections = [res1, res2, res3].filter((r) => r.status === 409);

    // Exactly 1 sibling can be retried; the other 2 must be rejected with 409
    expect(successes.length).toBe(1);
    expect(rejections.length).toBe(2);

    // Verify in real PostgreSQL directly:
    // 1. Payment authorizedPrintAttempts MUST equal exactly 3, NEVER 4 or 5
    const dbPayment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { authorizedPrintAttempts: true }
    });
    expect(dbPayment.authorizedPrintAttempts).toBe(3);

    // 2. Sum of sibling printAttempts in PostgreSQL must equal exactly 3
    const siblings = await prisma.printJob.findMany({
      where: { paymentId },
      select: { shortId: true, status: true, printAttempts: true }
    });
    const totalJobAttempts = siblings.reduce((sum, j) => sum + j.printAttempts, 0);
    expect(totalJobAttempts).toBe(3);

    // 3. Durable audit records exist in PostgreSQL
    const winningJob = siblings.find((j) => j.printAttempts === 2 || (j.status === 'PRINTING' || j.status === 'WAITING'));
    expect(winningJob).toBeDefined();

    const activityLogs = await prisma.activityLog.findMany({
      where: { action: 'PRINT_JOB_AUTHORIZED_RETRY' }
    });
    const retryLog = activityLogs.find((l) => l.details && l.details.includes(winningJob.shortId));
    expect(retryLog).toBeDefined();
  });

  test('9. Real PostgreSQL Concurrency on Port 5433: Concurrent Admin Retry vs Financial Refund Synchronization', async () => {
    if (!isPort5433Available) return;
    enforceSafety();

    const paymentId = 'pay_conc_sync_' + crypto.randomBytes(4).toString('hex');
    await prisma.payment.create({
      data: {
        id: paymentId,
        amount: 50,
        currency: 'INR',
        status: 'SUCCESS',
        type: 'UPI',
        authorizedPrintAttempts: 1,
        legacyAttemptsUnknown: false,
        gatewayOrderId: 'order_' + paymentId,
        gatewayPaymentId: 'cf_pay_' + paymentId
      }
    });

    const shortId = genShortId('conc_sync');
    await prisma.printJob.create({
      data: {
        shortId,
        documentId: defaultDoc.id,
        status: 'FAILED',
        paymentId,
        printAttempts: 1,
        legacyAttemptsUnknown: false,
        cost: 50
      }
    });

    const idempKey = 'idemp_sync_' + paymentId;
    const retryReason = 'Operator verified jam cleared, authorizing retry for customer';

    // Concurrently issue Admin Retry and Financial Refund for the same paymentId
    const [retryRes, refundRes] = await Promise.all([
      request(app).post('/api/admin/dispatch-job').send({ shortId, reason: retryReason }),
      request(app).post('/api/admin/refunds').send({
        paymentId,
        amount: 50,
        reason: 'Customer requested refund concurrently',
        idempotencyKey: idempKey
      })
    ]);

    // One must succeed, one must fail due to PostgreSQL advisory lock serialization
    const retrySucceeded = retryRes.status === 200 && retryRes.body.success === true;
    const refundSucceeded = refundRes.status === 201 && refundRes.body.success === true;

    expect(retrySucceeded !== refundSucceeded).toBe(true);

    if (retrySucceeded) {
      // Retry won the lock: Refund must be rejected with 409 because job was active (WAITING/PRINTING)
      expect(refundRes.status).toBe(409);
      expect(refundRes.body.error).toMatch(/Active print job is currently in progress/i);

      // Verify DB state
      const dbJob = await prisma.printJob.findUnique({ where: { shortId } });
      expect(['WAITING', 'PRINTING']).toContain(dbJob.status);

      const dbRefunds = await prisma.refund.findMany({
        where: { paymentId, status: { in: ['SUCCESS', 'PROCESSING'] } }
      });
      expect(dbRefunds.length).toBe(0);
    } else {
      // Refund won the lock: Retry must be rejected with 400/409 (PAYMENT_ALREADY_REFUNDED)
      expect([400, 409]).toContain(retryRes.status);
      expect(retryRes.body.error).toBe('PAYMENT_ALREADY_REFUNDED');

      // Verify DB state
      const dbJob = await prisma.printJob.findUnique({ where: { shortId } });
      expect(dbJob.status).toBe('FAILED');

      const dbRefund = await prisma.refund.findFirst({ where: { paymentId } });
      expect(dbRefund).not.toBeNull();
      expect(['SUCCESS', 'PROCESSING']).toContain(dbRefund.status);

      // Refund idempotency check: replay identical refund request with same idempotency key
      const replayRes = await request(app).post('/api/admin/refunds').send({
        paymentId,
        amount: 50,
        reason: 'Customer requested refund concurrently',
        idempotencyKey: idempKey
      });
      expect([200, 201]).toContain(replayRes.status);
    }

    // In both cases, attempt counter must remain correct and <= 3
    const finalPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(finalPayment.authorizedPrintAttempts).toBeLessThanOrEqual(3);
  });

  test('10. Stranded WAITING Job Reconciler: Recovers authorized retry stranded during crash window', async () => {
    if (!isPort5433Available) return;
    enforceSafety();

    const paymentId = 'pay_stranded_' + crypto.randomBytes(4).toString('hex');
    await prisma.payment.create({
      data: {
        id: paymentId,
        amount: 30,
        currency: 'INR',
        status: 'SUCCESS',
        type: 'UPI',
        authorizedPrintAttempts: 1,
        legacyAttemptsUnknown: false,
        gatewayOrderId: 'order_' + paymentId
      }
    });

    const shortId = genShortId('stranded');
    // Simulate crash after DB commit (status: WAITING) but before startPrintingProcess
    const oldTimestamp = new Date(Date.now() - 45000); // 45 seconds ago
    await prisma.printJob.create({
      data: {
        shortId,
        documentId: defaultDoc.id,
        status: 'WAITING',
        paymentId,
        printAttempts: 1,
        legacyAttemptsUnknown: false,
        cost: 30,
        updatedAt: oldTimestamp
      }
    });

    const { reconcileStrandedWaitingJobs } = require('../src/services/queueService');

    // Run reconciliation sweep with 15s threshold
    const summary = await reconcileStrandedWaitingJobs({
      prismaClient: prisma,
      thresholdMs: 15000
    });

    expect(summary.scannedCount).toBeGreaterThanOrEqual(1);
    expect(summary.dispatchedCount).toBeGreaterThanOrEqual(1);

    // Job in DB must now have transitioned out of stranded WAITING to PRINTING
    const freshJob = await prisma.printJob.findUnique({ where: { shortId } });
    expect(freshJob.status).toBe('PRINTING');
    expect(freshJob.printAttempts).toBe(2);

    // Payment authorized attempts incremented safely
    const freshPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(freshPayment.authorizedPrintAttempts).toBe(2);
  });

  test('11. In-process stranded WAITING reconcile: Retry commit + recovery + single dispatch + duplicate rejection on port 5433', async () => {
    if (!isPort5433Available) return;
    enforceSafety();

    const paymentId = 'pay_crash_restart_' + crypto.randomBytes(4).toString('hex');
    await prisma.payment.create({
      data: {
        id: paymentId,
        amount: 40,
        currency: 'INR',
        status: 'SUCCESS',
        type: 'UPI',
        authorizedPrintAttempts: 1,
        legacyAttemptsUnknown: false,
        gatewayOrderId: 'order_' + paymentId
      }
    });

    const shortId = genShortId('crash_rst');
    await prisma.printJob.create({
      data: {
        shortId,
        documentId: defaultDoc.id,
        status: 'FAILED',
        paymentId,
        printAttempts: 1,
        legacyAttemptsUnknown: false,
        cost: 40
      }
    });

    const maxAttempts = 3;
    const operatorReason = 'Operator resolved mechanical failure, authorized restart';

    // 1. Execute authorized retry transaction (identical to admin.routes.js transactional claim)
    await prisma.$transaction(async (tx) => {
      if (typeof tx.$executeRawUnsafe === 'function') {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('payment_refund_${paymentId}'))`);
      }

      const paymentRecord = await tx.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, status: true, authorizedPrintAttempts: true, legacyAttemptsUnknown: true }
      });
      expect(paymentRecord.status).toBe('SUCCESS');
      expect(paymentRecord.authorizedPrintAttempts).toBeLessThan(maxAttempts);

      // Atomically reserve attempt on Payment row inside transaction before commit
      const payRes = await tx.payment.updateMany({
        where: {
          id: paymentId,
          status: 'SUCCESS',
          authorizedPrintAttempts: { lt: maxAttempts },
          legacyAttemptsUnknown: false
        },
        data: {
          authorizedPrintAttempts: { increment: 1 }
        }
      });
      expect(payRes.count).toBe(1);

      // Claim PrintJob from FAILED to WAITING and reserve for retry
      const jobClaim = await tx.printJob.updateMany({
        where: {
          shortId,
          status: 'FAILED',
          legacyAttemptsUnknown: false,
          printAttempts: { lt: maxAttempts }
        },
        data: { status: 'WAITING', reservedForRetry: true }
      });
      expect(jobClaim.count).toBe(1);

      // Durable audit trail: ActivityLog
      await tx.activityLog.create({
        data: {
          action: 'PRINT_JOB_AUTHORIZED_RETRY',
          details: JSON.stringify({
            shortId,
            operatorReason,
            previousStatus: 'FAILED',
            newStatus: 'WAITING'
          })
        }
      });

      // Durable audit trail: PrintHistory
      const pj = await tx.printJob.findUnique({ where: { shortId } });
      await tx.printHistory.create({
        data: {
          printJobId: pj.id,
          success: false,
          errorDetails: `Authorized operator retry: ${operatorReason}`,
          completedAt: new Date()
        }
      });
    });

    // 2. Confirms database commit in PostgreSQL
    const committedPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(committedPayment.authorizedPrintAttempts).toBe(2);

    const committedJob = await prisma.printJob.findUnique({ where: { shortId } });
    expect(committedJob.status).toBe('WAITING');
    expect(committedJob.printAttempts).toBe(1);

    const auditLogs = await prisma.activityLog.findMany({
      where: { action: 'PRINT_JOB_AUTHORIZED_RETRY' }
    });
    const retryAudit = auditLogs.find((l) => l.details && l.details.includes(shortId));
    expect(retryAudit).toBeDefined();

    // 3. Inject simulated crash immediately before queue dispatch:
    // The backend crashed before startPrintingProcess was called.
    // In PostgreSQL, the job remains stranded in WAITING. Simulate elapsed time:
    const crashTimestamp = new Date(Date.now() - 40000); // 40 seconds ago
    await prisma.printJob.update({
      where: { shortId },
      data: { updatedAt: crashTimestamp }
    });

    // 4. Start fresh worker/backend process with mock socket boundary
    const emittedEvents = [];
    const mockIo = {
      to: jest.fn(() => ({
        emit: (event, payload) => {
          emittedEvents.push({ event, payload });
        }
      })),
      emit: jest.fn((event, payload) => {
        emittedEvents.push({ event, payload });
      })
    };

    // 5. Exercise real startup reconciliation path
    const { reconcileStrandedWaitingJobs, processJob } = require('../src/services/queueService');
    const summary = await reconcileStrandedWaitingJobs({
      prismaClient: prisma,
      io: mockIo,
      thresholdMs: 15000
    });

    // 6. Confirms the job is recovered and dispatched once
    expect(summary.scannedCount).toBeGreaterThanOrEqual(1);
    expect(summary.dispatchedCount).toBeGreaterThanOrEqual(1);

    const recoveredJob = await prisma.printJob.findUnique({ where: { shortId } });
    expect(recoveredJob.status).toBe('PRINTING');

    // 7. Confirms Payment and PrintJob attempt counters remain correct (NO DOUBLE-COUNTING)
    expect(recoveredJob.printAttempts).toBe(2);
    const finalPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(finalPayment.authorizedPrintAttempts).toBe(2); // Still 2, not double-counted to 3!

    // 8. Confirms durable ActivityLog and PrintHistory records remain present
    const finalAudit = await prisma.activityLog.findMany({
      where: { action: 'PRINT_JOB_AUTHORIZED_RETRY' }
    });
    expect(finalAudit.some((a) => a.details && a.details.includes(shortId))).toBe(true);

    const finalHistory = await prisma.printHistory.findMany({
      where: { printJobId: recoveredJob.id }
    });
    expect(finalHistory.length).toBeGreaterThanOrEqual(1);

    // 9. Confirms duplicate queue delivery cannot create duplicate physical printing
    const initialEmitCount = emittedEvents.filter(e => e.event === 'physical_print_job').length;
    const dupRes = await processJob(shortId);
    expect(dupRes.success).toBe(false);
    expect(dupRes.code).toBe('INVALID_TRANSITION');

    // Counters remain unchanged
    const afterDupJob = await prisma.printJob.findUnique({ where: { shortId } });
    expect(afterDupJob.printAttempts).toBe(2);
    const afterDupPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(afterDupPayment.authorizedPrintAttempts).toBe(2);

    const finalEmitCount = emittedEvents.filter(e => e.event === 'physical_print_job').length;
    expect(finalEmitCount).toBe(initialEmitCount);
  });

  test('12. Real child-process restart: spawn isolated Node.js worker, fresh PrismaClient, startup reconciliation dispatches exactly once, and duplicate recovery is rejected', async () => {
    if (!isPort5433Available) return;
    enforceSafety();

    // 1. Create a fresh payment + job in FAILED state, authorize a retry (FAILED → WAITING),
    //    then simulate crash (do NOT call startPrintingProcess).
    // An isolated test machine is created so queueService routes physical_print_job events to this room.
    const machineId = 'mach_child_' + crypto.randomBytes(4).toString('hex');
    await prisma.machine.create({
      data: {
        id: machineId,
        machineKey: 'key_' + machineId,
        name: 'Child Worker Test Machine'
      }
    });

    const paymentId = 'pay_child_spawn_' + crypto.randomBytes(4).toString('hex');
    await prisma.payment.create({
      data: {
        id: paymentId,
        amount: 25,
        currency: 'INR',
        status: 'SUCCESS',
        type: 'UPI',
        authorizedPrintAttempts: 1,
        legacyAttemptsUnknown: false,
        gatewayOrderId: 'order_' + paymentId
      }
    });

    const shortId = genShortId('cp12');
    await prisma.printJob.create({
      data: {
        shortId,
        documentId: defaultDoc.id,
        machineId,
        status: 'FAILED',
        paymentId,
        printAttempts: 1,
        legacyAttemptsUnknown: false,
        cost: 25
      }
    });

    // 2. Atomically reserve the retry: FAILED → WAITING + reservedForRetry + increment authorizedPrintAttempts
    await prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { id: paymentId, status: 'SUCCESS', authorizedPrintAttempts: { lt: 3 }, legacyAttemptsUnknown: false },
        data: { authorizedPrintAttempts: { increment: 1 } }
      });
      await tx.printJob.updateMany({
        where: { shortId, status: 'FAILED', printAttempts: { lt: 3 }, legacyAttemptsUnknown: false },
        data: { status: 'WAITING', reservedForRetry: true }
      });
    });

    // 3. Simulate crash: backdate updatedAt so reconciler threshold triggers
    const crashTimestamp = new Date(Date.now() - 40000);
    await prisma.printJob.update({ where: { shortId }, data: { updatedAt: crashTimestamp } });

    // Verify pre-conditions
    const preJob = await prisma.printJob.findUnique({ where: { shortId } });
    expect(preJob.status).toBe('WAITING');
    expect(preJob.reservedForRetry).toBe(true);
    expect(preJob.printAttempts).toBe(1);

    // Helper to query durable ActivityLog records for this specific target job
    const getTargetAuditDispatches = async () => {
      const logs = await prisma.activityLog.findMany({
        where: { action: 'PRINT_ATTEMPT_DISPATCHED' }
      });
      return logs.filter(a => a.details && a.details.includes(shortId)).length;
    };
    expect(await getTargetAuditDispatches()).toBe(0);

    const childScript = path.join(__dirname, 'helpers', 'child-reconcile-worker.js');
    const dbUrl = DATABASE_URL;

    // Helper to spawn an isolated child reconciliation worker and capture parsed JSON
    const spawnChildWorker = (targetShortId) => {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [childScript, targetShortId, dbUrl], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, DATABASE_URL: dbUrl }
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });

        child.on('close', (code) => {
          try {
            const lines = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
            const jsonLine = lines.find(l => l.startsWith('{') && l.endsWith('}')) || lines[lines.length - 1] || '{}';
            const parsed = JSON.parse(jsonLine);
            resolve({ code, ...parsed, stderr, rawStdout: stdout });
          } catch (parseErr) {
            reject(new Error(`Child process output not JSON (exit ${code}): ${stdout} | stderr: ${stderr}`));
          }
        });

        child.on('error', reject);
      });
    };

    // 4. Launch FIRST fresh child process for reconciliation
    const child1Result = await spawnChildWorker(shortId);

    // 5. Verify first child reconciliation succeeds and target job is dispatched exactly once
    expect(child1Result.code).toBe(0);
    expect(child1Result.success).toBe(true);
    expect(child1Result.prismaDisconnected).toBe(true);
    // Target-specific physical dispatch event evidence: exactly one event produced for target shortId
    expect(child1Result.targetEventCount).toBe(1);
    expect(child1Result.targetDispatched).toBe(true);
    expect(child1Result.targetInitialStatus).toBe('WAITING');
    expect(child1Result.jobStatus).toBe('PRINTING');
    expect(child1Result.jobPrintAttempts).toBe(2);
    // Payment authorizedPrintAttempts must NOT be double-counted (stays at 2, not 3)
    expect(child1Result.paymentAuthorizedAttempts).toBe(2);
    // reservedForRetry must be cleared after successful WAITING→PRINTING transition
    expect(child1Result.reservedForRetry).toBe(false);

    // Assert exactly one ActivityLog entry for target shortId with action PRINT_ATTEMPT_DISPATCHED
    const auditCountAfterChild1 = await getTargetAuditDispatches();
    expect(auditCountAfterChild1).toBe(1);

    // 6. Confirm in parent's view (independent DB read)
    const afterChild1Job = await prisma.printJob.findUnique({ where: { shortId } });
    expect(afterChild1Job.status).toBe('PRINTING');
    expect(afterChild1Job.printAttempts).toBe(2);
    expect(afterChild1Job.reservedForRetry).toBe(false);

    const afterChild1Payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(afterChild1Payment.authorizedPrintAttempts).toBe(2);

    // 7. Launch a SECOND fresh child process for reconciliation (duplicate recovery simulation)
    const child2Result = await spawnChildWorker(shortId);

    // 8. Verify the same target job is NOT dispatched again
    expect(child2Result.code).toBe(0);
    expect(child2Result.success).toBe(true);
    expect(child2Result.prismaDisconnected).toBe(true);
    // Second child must produce ZERO events for that target shortId
    expect(child2Result.targetEventCount).toBe(0);
    expect(child2Result.targetDispatched).toBe(false);
    expect(child2Result.targetInitialStatus).toBe('PRINTING');
    expect(child2Result.jobStatus).toBe('PRINTING');
    // All counters remain unchanged
    expect(child2Result.jobPrintAttempts).toBe(2);
    expect(child2Result.paymentAuthorizedAttempts).toBe(2);
    expect(child2Result.reservedForRetry).toBe(false);

    // Assert ActivityLog count remains unchanged after second child (still exactly 1)
    const auditCountAfterChild2 = await getTargetAuditDispatches();
    expect(auditCountAfterChild2).toBe(1);

    // 9. Independent DB read confirms no duplicate increment or state change
    const afterChild2Job = await prisma.printJob.findUnique({ where: { shortId } });
    expect(afterChild2Job.status).toBe('PRINTING');
    expect(afterChild2Job.printAttempts).toBe(2);
    expect(afterChild2Job.reservedForRetry).toBe(false);

    const afterChild2Payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(afterChild2Payment.authorizedPrintAttempts).toBe(2);
  });
});

describe('child-reconcile-worker DATABASE_URL Safety Guard Unit Tests', () => {
  test('A1. Production hostname with disposable database name is strictly rejected', () => {
    const res = validateDatabaseUrl('postgresql://postgres:pass@production-db:5433/printgo_disposable_target');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/hostname must be '127\.0\.0\.1' or 'localhost'/);
  });

  test('A2. Production hostname with 5433 in query string is strictly rejected', () => {
    const res = validateDatabaseUrl('postgresql://postgres:pass@production-db:5432/printgo_disposable_target?port=5433');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/hostname must be '127\.0\.0\.1' or 'localhost'/);
  });

  test('A3. Port 5432 with disposable database name is strictly rejected', () => {
    const res = validateDatabaseUrl('postgresql://postgres:pass@127.0.0.1:5432/printgo_disposable_target');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/port must be exactly '5433'/);
  });

  test('A4. Port 5433 with alternate database is strictly rejected', () => {
    const res = validateDatabaseUrl('postgresql://postgres:pass@127.0.0.1:5433/production_database');
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/pathname must be exactly '\/printgo_disposable_target'/);
  });

  test('A5. Malformed or missing URL is strictly rejected', () => {
    const res1 = validateDatabaseUrl('this_is_not_a_valid_url');
    expect(res1.valid).toBe(false);
    expect(res1.error).toMatch(/Malformed DATABASE_URL/);

    const res2 = validateDatabaseUrl('');
    expect(res2.valid).toBe(false);
    expect(res2.error).toMatch(/Missing or empty/);

    const res3 = validateDatabaseUrl(null);
    expect(res3.valid).toBe(false);
    expect(res3.error).toMatch(/Missing or empty/);
  });

  test('A6. Valid exact disposable database URL is strictly accepted', () => {
    const res1 = validateDatabaseUrl('postgresql://postgres@127.0.0.1:5433/printgo_disposable_target');
    expect(res1.valid).toBe(true);

    const res2 = validateDatabaseUrl('postgresql://postgres@127.0.0.1:5433/printgo_disposable_target?schema=public');
    expect(res2.valid).toBe(true);

    const res3 = validateDatabaseUrl('postgresql://postgres:postgres@localhost:5433/printgo_disposable_target?schema=public');
    expect(res3.valid).toBe(true);
  });

  test('A7. Child worker execution with invalid URL exits with code 1 and never connects to DB', async () => {
    const childScript = path.join(__dirname, 'helpers', 'child-reconcile-worker.js');
    const invalidUrl = 'postgresql://postgres@production-db:5432/printgo_disposable_target';

    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [childScript, 'dummy_short_id', invalidUrl], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.on('close', (code) => {
        try {
          resolve({ code, parsed: JSON.parse(stdout) });
        } catch (_) {
          resolve({ code, stdout });
        }
      });
    });

    expect(result.code).toBe(1);
    expect(result.parsed.success).toBe(false);
    expect(result.parsed.error).toMatch(/SAFETY REJECTION/);
  });
});
