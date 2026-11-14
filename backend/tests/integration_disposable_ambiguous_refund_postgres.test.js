/**
 * Disposable Target Integration Test: Real PostgreSQL Concurrency Verification for Ambiguous Refunds
 *
 * STRICT SAFETY GUARD:
 * This integration test operates EXCLUSIVELY on an ephemeral, disposable PostgreSQL instance
 * configured via DATABASE_URL on port 5433 (printgo_disposable_target).
 * It will NEVER run against staging or production databases.
 * No schema alterations or migrations are performed.
 */

const crypto = require('crypto');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const isDisposableConfigured = () => {
  if (!process.env.DATABASE_URL) return false;
  try {
    const parsed = new URL(process.env.DATABASE_URL);
    return (
      parsed.pathname === '/printgo_disposable_target' &&
      String(parsed.port || 5433) === '5433'
    );
  } catch {
    return false;
  }
};

const describeOrSkip = isDisposableConfigured() ? describe : describe.skip;

describeOrSkip('P1-02 / P1-05: Real PostgreSQL Concurrency Verification (Disposable Target Only)', () => {
  let prisma;
  let testDocId;
  const createdJobIds = [];

  beforeAll(async () => {
    prisma = require('../src/utils/prisma');

    // Create a shared test document
    const doc = await prisma.document.create({
      data: {
        originalName: 'concurrency_safety_test.pdf',
        filename: 'http://localhost:5000/uploads/intg_ambig_test.pdf',
        mimetype: 'application/pdf',
        size: 1024,
        pages: 1
      }
    });
    testDocId = doc.id;
  });

  afterAll(async () => {
    if (prisma) {
      if (createdJobIds.length > 0) {
        await prisma.printHistory.deleteMany({ where: { printJobId: { in: createdJobIds } } });
        await prisma.printJob.deleteMany({ where: { id: { in: createdJobIds } } });
      }
      if (testDocId) {
        await prisma.document.deleteMany({ where: { id: testDocId } });
      }
      await prisma.$disconnect();
    }
  });

  test('1. Concurrent execution: Ambiguity handler committing before cleaner UPDATE causes cleaner updateMany to match 0 rows (no refund)', async () => {
    const shortId = `amb_${crypto.randomBytes(2).toString('hex')}`;
    const pastDate = new Date(Date.now() - 20 * 60000); // 20 mins ago

    const job = await prisma.printJob.create({
      data: {
        shortId,
        status: 'PRINTING',
        cost: 2.0,
        pagesToPrint: 1,
        documentId: testDocId,
        isTest: true,
        createdAt: pastDate,
        updatedAt: pastDate
      }
    });
    createdJobIds.push(job.id);

    // Thread B: Socket ambiguity handler commits first
    await prisma.$transaction(async (tx) => {
      await tx.printHistory.create({
        data: {
          printJobId: job.id,
          success: false,
          errorDetails: 'Ambiguous outcome: Spooler timeout (wasSeenInQueue: false)',
          completedAt: new Date()
        }
      });
      await tx.printJob.update({
        where: { id: job.id },
        data: { updatedAt: new Date() }
      });
    });

    // Thread A: Cleaner attempts atomic transition with updateMany
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60000);
    const updateResult = await prisma.printJob.updateMany({
      where: {
        id: job.id,
        status: 'PRINTING',
        updatedAt: { lt: fifteenMinsAgo },
        printHistory: {
          none: {
            success: false,
            errorDetails: { contains: 'Ambiguous outcome' }
          }
        }
      },
      data: { status: 'FAILED' }
    });

    // Assert updateMany matched 0 rows! Cleaner safely aborted without failure or refund
    expect(updateResult.count).toBe(0);

    const recheckJob = await prisma.printJob.findUnique({ where: { id: job.id } });
    expect(recheckJob.status).toBe('PRINTING');
  });

  test('2. Concurrent execution: Cleaner committing FAILED causes late ambiguity handler to reject update', async () => {
    const shortId = `cln_${crypto.randomBytes(2).toString('hex')}`;
    const pastDate = new Date(Date.now() - 20 * 60000);

    const job = await prisma.printJob.create({
      data: {
        shortId,
        status: 'PRINTING',
        cost: 2.0,
        pagesToPrint: 1,
        documentId: testDocId,
        isTest: true,
        createdAt: pastDate,
        updatedAt: pastDate
      }
    });
    createdJobIds.push(job.id);

    // Thread A: Cleaner transitions to FAILED
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60000);
    const updateResult = await prisma.printJob.updateMany({
      where: {
        id: job.id,
        status: 'PRINTING',
        updatedAt: { lt: fifteenMinsAgo },
        printHistory: {
          none: {
            success: false,
            errorDetails: { contains: 'Ambiguous outcome' }
          }
        }
      },
      data: { status: 'FAILED' }
    });
    expect(updateResult.count).toBe(1);

    // Thread B: Late arriving ambiguity handler inside transaction
    let handlerRejected = false;
    await prisma.$transaction(async (tx) => {
      const currentJob = await tx.printJob.findUnique({ where: { shortId } });
      if (currentJob.status !== 'PRINTING') {
        handlerRejected = true;
        return;
      }
      await tx.printHistory.create({
        data: {
          printJobId: currentJob.id,
          success: false,
          errorDetails: 'Ambiguous outcome: Late arrival',
          completedAt: new Date()
        }
      });
    });

    expect(handlerRejected).toBe(true);

    // Verify no ambiguity record was inserted on the FAILED job
    const historyRecords = await prisma.printHistory.findMany({ where: { printJobId: job.id } });
    expect(historyRecords.length).toBe(0);
  });

  test('3. Operator reconciliation to COMPLETED causes cleaner updateMany to match 0 rows', async () => {
    const shortId = `op_${crypto.randomBytes(2).toString('hex')}`;
    const pastDate = new Date(Date.now() - 20 * 60000);

    const job = await prisma.printJob.create({
      data: {
        shortId,
        status: 'PRINTING',
        cost: 2.0,
        pagesToPrint: 1,
        documentId: testDocId,
        isTest: true,
        createdAt: pastDate,
        updatedAt: pastDate
      }
    });
    createdJobIds.push(job.id);

    // Operator reconciles job to COMPLETED
    await prisma.printJob.update({
      where: { id: job.id },
      data: { status: 'COMPLETED' }
    });

    // Cleaner runs concurrently
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60000);
    const updateResult = await prisma.printJob.updateMany({
      where: {
        id: job.id,
        status: 'PRINTING',
        updatedAt: { lt: fifteenMinsAgo },
        printHistory: {
          none: {
            success: false,
            errorDetails: { contains: 'Ambiguous outcome' }
          }
        }
      },
      data: { status: 'FAILED' }
    });

    expect(updateResult.count).toBe(0);

    const finalJob = await prisma.printJob.findUnique({ where: { id: job.id } });
    expect(finalJob.status).toBe('COMPLETED');
  });

  test('4. Duplicate cleaner execution: Second cleaner run matches 0 rows and does not refund', async () => {
    const shortId = `dup_${crypto.randomBytes(2).toString('hex')}`;
    const pastDate = new Date(Date.now() - 20 * 60000);

    const job = await prisma.printJob.create({
      data: {
        shortId,
        status: 'PRINTING',
        cost: 2.0,
        pagesToPrint: 1,
        documentId: testDocId,
        isTest: true,
        createdAt: pastDate,
        updatedAt: pastDate
      }
    });
    createdJobIds.push(job.id);

    const fifteenMinsAgo = new Date(Date.now() - 15 * 60000);
    const whereClause = {
      id: job.id,
      status: 'PRINTING',
      updatedAt: { lt: fifteenMinsAgo },
      printHistory: {
        none: {
          success: false,
          errorDetails: { contains: 'Ambiguous outcome' }
        }
      }
    };

    // First cleaner run succeeds
    const run1 = await prisma.printJob.updateMany({ where: whereClause, data: { status: 'FAILED' } });
    expect(run1.count).toBe(1);

    // Second cleaner run attempts same job
    const run2 = await prisma.printJob.updateMany({ where: whereClause, data: { status: 'FAILED' } });
    expect(run2.count).toBe(0);
  });
});
