const prisma = require('../src/utils/prisma');
const jobsService = require('../src/modules/jobs/jobs.service');

function assertDisposableDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for the integration test.');
  const parsed = new URL(raw);
  const databaseName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || databaseName !== 'printgo_disposable_target') {
    throw new Error('Safety stop: integration tests may run only against local printgo_disposable_target.');
  }
}

describe('Finding 4 — Ambiguous Job Resolution Concurrency Safety Integration', () => {
  const companyId = 'co_res_concurrency_01';
  const machineId = 'm_res_concurrency_01';
  const documentId = 'doc_res_concurrency_01';
  const superadmin = {
    id: 'user_res_admin_01',
    email: 'res_admin@printgo.test',
    role: 'SUPERADMIN'
  };

  beforeAll(async () => {
    assertDisposableDatabaseUrl();

    // 1. Seed Company
    await prisma.company.upsert({
      where: { id: companyId },
      create: {
        id: companyId,
        name: 'Resolution Concurrency Co',
        contactEmail: 'concurrency@printgo.test'
      },
      update: {}
    });

    // 2. Seed Machine
    await prisma.machine.upsert({
      where: { id: machineId },
      create: {
        id: machineId,
        name: 'Resolution PC',
        companyId,
        status: 'ACTIVE',
        machineKey: 'mach_key_res_01'
      },
      update: { status: 'ACTIVE' }
    });

    // 3. Seed Superadmin User
    await prisma.user.upsert({
      where: { id: superadmin.id },
      create: {
        id: superadmin.id,
        email: superadmin.email,
        password: 'hashed_password_test',
        name: 'Resolution Admin',
        role: 'SUPERADMIN'
      },
      update: {}
    });

    // 4. Seed Document
    await prisma.document.upsert({
      where: { id: documentId },
      create: {
        id: documentId,
        originalName: 'concurrency_test_doc.pdf',
        filename: '/uploads/concurrency_test_doc.pdf',
        mimetype: 'application/pdf',
        size: 2048,
        pages: 2
      },
      update: {}
    });
  });

  afterAll(async () => {
    await prisma.activityLog.deleteMany({
      where: { details: { contains: 'res-c-' } }
    }).catch(() => {});
    await prisma.printHistory.deleteMany({
      where: { printJob: { shortId: { startsWith: 'res-c-' } } }
    }).catch(() => {});
    await prisma.printJob.deleteMany({
      where: { shortId: { startsWith: 'res-c-' } }
    }).catch(() => {});
    await prisma.document.deleteMany({ where: { id: documentId } }).catch(() => {});
    await prisma.machine.deleteMany({ where: { id: machineId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: superadmin.id } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
    await prisma.$disconnect();
  });

  test('proves two concurrent conflicting resolutions (COMPLETED vs FAILED) result in exactly one winner, 409 Conflict for loser, no overwrite, and exactly one PrintHistory and ActivityLog', async () => {
    const shortId = 'res-c-conflicting';
    const jobId = 'job_uuid_res_conflicting';

    // Seed a PrintJob in PRINTING status
    const createdJob = await prisma.printJob.create({
      data: {
        id: jobId,
        shortId,
        status: 'PRINTING',
        cost: 20,
        pagesToPrint: 2,
        copies: 1,
        color: 'bw',
        duplex: 'single',
        paperSize: 'A4',
        machineId,
        documentId
      }
    });

    expect(createdJob.status).toBe('PRINTING');

    // Fire two concurrent resolution attempts with conflicting outcomes
    const promiseCompleted = jobsService.resolveAmbiguousJob(
      shortId,
      {
        outcome: 'COMPLETED',
        reason: 'Physical inspection confirmed document in tray',
        physicalConfirmation: true,
        spoolerEmptyOnly: false
      },
      superadmin
    );

    const promiseFailed = jobsService.resolveAmbiguousJob(
      shortId,
      {
        outcome: 'FAILED',
        reason: 'Paper jam occurred inside the drum unit',
        spoolerEmptyOnly: false
      },
      superadmin
    );

    const results = await Promise.allSettled([promiseCompleted, promiseFailed]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one must succeed, exactly one must be rejected
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winningResult = fulfilled[0].value;
    const losingError = rejected[0].reason;

    // Verify winner
    expect(['COMPLETED', 'FAILED']).toContain(winningResult.status);

    // Verify loser got 409 Conflict
    expect(losingError.statusCode).toBe(409);
    expect(losingError.message).toMatch(/Conflict: Job res-c-conflicting has already been resolved to/i);
    expect(losingError.message).toContain(winningResult.status);

    // Verify database state: status in DB matches winning outcome and was NOT overwritten
    const finalJob = await prisma.printJob.findUnique({
      where: { id: jobId }
    });
    expect(finalJob.status).toBe(winningResult.status);

    // Verify exactly ONE PrintHistory record was created
    const printHistories = await prisma.printHistory.findMany({
      where: { printJobId: jobId }
    });
    expect(printHistories).toHaveLength(1);
    expect(printHistories[0].success).toBe(winningResult.status === 'COMPLETED');

    // Verify exactly ONE ActivityLog record was created
    const activityLogs = await prisma.activityLog.findMany({
      where: { details: { contains: shortId } }
    });
    expect(activityLogs).toHaveLength(1);
    const parsedDetails = JSON.parse(activityLogs[0].details);
    expect(parsedDetails.newStatus).toBe(winningResult.status);
    expect(parsedDetails.previousStatus).toBe('PRINTING');
  });

  test('proves two concurrent matching resolutions (both COMPLETED) succeed idempotently with exactly one PrintHistory and one ActivityLog', async () => {
    const shortId = 'res-c-matching';
    const jobId = 'job_uuid_res_matching';

    // Seed a PrintJob in PRINTING status
    await prisma.printJob.create({
      data: {
        id: jobId,
        shortId,
        status: 'PRINTING',
        cost: 30,
        pagesToPrint: 3,
        copies: 1,
        color: 'bw',
        duplex: 'single',
        paperSize: 'A4',
        machineId,
        documentId
      }
    });

    // Fire two concurrent resolution attempts with matching COMPLETED outcomes
    const promise1 = jobsService.resolveAmbiguousJob(
      shortId,
      {
        outcome: 'COMPLETED',
        reason: 'Operator 1 confirmed output in output tray',
        physicalConfirmation: true,
        spoolerEmptyOnly: false
      },
      superadmin
    );

    const promise2 = jobsService.resolveAmbiguousJob(
      shortId,
      {
        outcome: 'COMPLETED',
        reason: 'Operator 2 confirmed output in output tray',
        physicalConfirmation: true,
        spoolerEmptyOnly: false
      },
      superadmin
    );

    const [res1, res2] = await Promise.all([promise1, promise2]);

    expect(res1.status).toBe('COMPLETED');
    expect(res2.status).toBe('COMPLETED');

    // Verify database state
    const finalJob = await prisma.printJob.findUnique({
      where: { id: jobId }
    });
    expect(finalJob.status).toBe('COMPLETED');

    // Even though both succeeded (one applied, one idempotent), exactly ONE PrintHistory exists
    const printHistories = await prisma.printHistory.findMany({
      where: { printJobId: jobId }
    });
    expect(printHistories).toHaveLength(1);
    expect(printHistories[0].success).toBe(true);

    // Exactly ONE ActivityLog exists
    const activityLogs = await prisma.activityLog.findMany({
      where: { details: { contains: shortId } }
    });
    expect(activityLogs).toHaveLength(1);
  });
});
