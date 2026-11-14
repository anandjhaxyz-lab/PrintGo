/**
 * Disposable Target Integration Test: Real PostgreSQL Atomic Concurrency Verification (P1-05)
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

describeOrSkip('P1-05: Real PostgreSQL Atomic Claim Verification (Disposable Target Only)', () => {
  let prisma;
  let testJobId;
  let testDocId;
  let shortId;

  beforeAll(async () => {
    prisma = require('../src/utils/prisma');
    shortId = `intg_${crypto.randomBytes(2).toString('hex')}`;

    // Seed test document
    const doc = await prisma.document.create({
      data: {
        originalName: 'postgres_concurrency_test.pdf',
        filename: 'http://localhost:5000/uploads/intg_test.pdf',
        mimetype: 'application/pdf',
        size: 1024,
        pages: 1
      }
    });
    testDocId = doc.id;

    // Seed test job in WAITING status
    const job = await prisma.printJob.create({
      data: {
        shortId,
        status: 'WAITING',
        cost: 5.0,
        pagesToPrint: 1,
        documentId: testDocId,
        isTest: true
      }
    });
    testJobId = job.id;
  });

  afterAll(async () => {
    if (prisma) {
      if (testJobId) {
        await prisma.printJob.deleteMany({ where: { id: testJobId } });
      }
      if (testDocId) {
        await prisma.document.deleteMany({ where: { id: testDocId } });
      }
      await prisma.$disconnect();
    }
  });

  test('PostgreSQL row-level locking guarantees exactly one winner for concurrent updateMany claims', async () => {
    // Run two simultaneous updateMany queries targeting the exact same record
    const [res1, res2] = await Promise.all([
      prisma.printJob.updateMany({
        where: { shortId, status: 'WAITING' },
        data: { status: 'PRINTING' }
      }),
      prisma.printJob.updateMany({
        where: { shortId, status: 'WAITING' },
        data: { status: 'PRINTING' }
      })
    ]);

    // One must have count === 1, the other count === 0
    const counts = [res1.count, res2.count].sort();
    expect(counts).toEqual([0, 1]);

    // Database record is now definitively PRINTING
    const finalJob = await prisma.printJob.findUnique({ where: { shortId } });
    expect(finalJob.status).toBe('PRINTING');
  });
});
