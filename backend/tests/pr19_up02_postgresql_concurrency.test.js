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

function genShortId(prefix = 'j') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5433/printgo_disposable_target?schema=public';
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
});
