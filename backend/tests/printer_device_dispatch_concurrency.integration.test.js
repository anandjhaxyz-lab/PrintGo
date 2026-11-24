const prisma = require('../src/utils/prisma');
const {
  authorizePrinterDeviceDispatch
} = require('../src/services/printerDeviceJobBinding.service');
const {
  disablePrinterDevice
} = require('../src/services/printerDeviceAdmin.service');
const {
  updateJobStatus
} = require('../src/modules/jobs/jobs.service');

function assertDisposableDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for the integration test.');
  const parsed = new URL(raw);
  const databaseName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || databaseName !== 'printgo_disposable_target') {
    throw new Error('Safety stop: integration tests may run only against local printgo_disposable_target.');
  }
}

describe('Real Production Service Dispatch Concurrency & Force Reconciliation Integration', () => {
  const machineId = 'm_concurrency_test_01';
  const companyId = 'co_concurrency_test_01';
  const printerDeviceId = 'dev_concurrency_test_01';
  const windowsPrinterName = 'Epson L6460 Concurrency';
  const superadmin = { id: 'admin_test_01', email: 'admin@test.com', role: 'SUPERADMIN' };
  let testDocumentId;

  beforeAll(async () => {
    assertDisposableDatabaseUrl();
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'true';

    // Seed Document
    const doc = await prisma.document.create({
      data: {
        originalName: 'concurrency_test.pdf',
        filename: '/uploads/concurrency_test.pdf',
        mimetype: 'application/pdf',
        size: 2048,
        pages: 1
      }
    });
    testDocumentId = doc.id;

    // Seed Superadmin User
    await prisma.user.upsert({
      where: { id: superadmin.id },
      create: {
        id: superadmin.id,
        email: superadmin.email,
        password: 'hashed_password_test',
        name: 'Super Admin Test',
        role: 'SUPERADMIN'
      },
      update: {}
    });

    // Seed Machine and Company
    await prisma.company.upsert({
      where: { id: companyId },
      create: { id: companyId, name: 'Concurrency Co', contactEmail: 'concurrency@test.com' },
      update: {}
    });

    await prisma.machine.upsert({
      where: { id: machineId },
      create: {
        id: machineId,
        name: 'Concurrency PC',
        companyId,
        status: 'ACTIVE',
        machineKey: 'mach_key_concurrency_01'
      },
      update: { status: 'ACTIVE' }
    });

    // Seed PrinterDevice
    await prisma.printerDevice.upsert({
      where: { id: printerDeviceId },
      create: {
        id: printerDeviceId,
        machineId,
        displayName: 'Epson Counter Concurrency',
        windowsPrinterName,
        status: 'ACTIVE',
        approvedAt: new Date()
      },
      update: {
        status: 'ACTIVE',
        windowsPrinterName,
        approvedAt: new Date()
      }
    });
  });

  afterAll(async () => {
    delete process.env.ENABLE_MULTI_PRINTER_DISPATCH;
    await prisma.printerDeviceDispatchLease.deleteMany({ where: { printerDeviceId } }).catch(() => {});
    await prisma.printJob.deleteMany({ where: { machineId } }).catch(() => {});
    if (testDocumentId) {
      await prisma.document.delete({ where: { id: testDocumentId } }).catch(() => {});
    }
    await prisma.printerDevice.deleteMany({ where: { id: printerDeviceId } }).catch(() => {});
    await prisma.machine.deleteMany({ where: { id: machineId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: superadmin.id } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset device to ACTIVE and clear leases
    await prisma.printerDevice.update({
      where: { id: printerDeviceId },
      data: { status: 'ACTIVE' }
    });
    await prisma.printerDeviceDispatchLease.deleteMany({
      where: { printerDeviceId }
    });
  });

  const createTestJob = async (shortId, status = 'PRINTING') => {
    return await prisma.printJob.create({
      data: {
        shortId,
        machineId,
        documentId: testDocumentId,
        printerDeviceId,
        printerWindowsQueueName: windowsPrinterName,
        status,
        cost: 10.0,
        copies: 1,
        pagesToPrint: 1,
        paperSize: 'A4'
      }
    });
  };

  test('proves two concurrent dispatch authorization requests for the same PrinterDevice are serialized and exactly ONE succeeds', async () => {
    const job1 = await createTestJob('job_concurrent_01');
    const job2 = await createTestJob('job_concurrent_02');

    const socket1 = { userType: 'printer', machineId, emit: jest.fn() };
    const socket2 = { userType: 'printer', machineId, emit: jest.fn() };

    // Run both authorization attempts simultaneously via Promise.all
    const [res1, res2] = await Promise.all([
      authorizePrinterDeviceDispatch({
        socket: socket1,
        prisma,
        request: {
          requestId: 'req_c_01',
          jobId: job1.shortId,
          printerDeviceId,
          windowsPrinterName
        }
      }),
      authorizePrinterDeviceDispatch({
        socket: socket2,
        prisma,
        request: {
          requestId: 'req_c_02',
          jobId: job2.shortId,
          printerDeviceId,
          windowsPrinterName
        }
      })
    ]);

    const results = [res1, res2];
    const successes = results.filter(r => r.accepted === true);
    const failures = results.filter(r => r.accepted === false && r.code === 'DEVICE_DISPATCH_IN_PROGRESS');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // Verify exactly one active lease exists in DB
    const activeLease = await prisma.printerDeviceDispatchLease.findUnique({
      where: { printerDeviceId }
    });
    expect(activeLease).not.toBeNull();
    expect(activeLease.jobShortId).toBe(successes[0].requestId === 'req_c_01' ? job1.shortId : job2.shortId);
    expect(activeLease.releasedAt).toBeNull();
  });

  test('proves concurrent dispatch versus force reconciliation serializes and prevents overlapping operations', async () => {
    const job = await createTestJob('job_concurrent_force_01');
    const socket = { userType: 'printer', machineId, emit: jest.fn() };

    // Simultaneous dispatch and force-reconciliation / disable
    const dispatchPromise = authorizePrinterDeviceDispatch({
      socket,
      prisma,
      request: {
        requestId: 'req_force_vs_dispatch',
        jobId: job.shortId,
        printerDeviceId,
        windowsPrinterName
      }
    });

    const disablePromise = disablePrinterDevice(
      printerDeviceId,
      {
        reason: 'Maintenance requested by operator concurrency audit',
        forceReconcileLease: true
      },
      superadmin,
      prisma
    ).catch(err => ({ error: true, code: err.code, statusCode: err.statusCode }));

    const [dispatchResult, disableResult] = await Promise.all([dispatchPromise, disablePromise]);

    if (dispatchResult.accepted) {
      // Dispatch won lock first: disable must have been rejected with 409 DEVICE_DISPATCH_IN_PROGRESS
      expect(disableResult.error).toBe(true);
      expect(disableResult.code).toBe('DEVICE_DISPATCH_IN_PROGRESS');
    } else {
      // Disable won lock first: device became DISABLED, so dispatch must have failed with DEVICE_NOT_ACTIVE
      expect(dispatchResult.code).toBe('DEVICE_NOT_ACTIVE');
    }
  });

  test('proves a PRINTING job cannot be bypassed after force reconciliation', async () => {
    const job1 = await createTestJob('job_stuck_printing_01', 'PRINTING');
    const job2 = await createTestJob('job_candidate_02', 'PRINTING');

    // Create an expired lease for job 1
    await prisma.printerDeviceDispatchLease.upsert({
      where: { printerDeviceId },
      create: {
        printerDeviceId,
        requestId: 'req_stuck_01',
        jobShortId: job1.shortId,
        expiresAt: new Date(Date.now() - 60000), // Expired 1 min ago
        releasedAt: null
      },
      update: {
        requestId: 'req_stuck_01',
        jobShortId: job1.shortId,
        expiresAt: new Date(Date.now() - 60000),
        releasedAt: null
      }
    });

    // Operator executes force-reconciliation on the expired lease
    await disablePrinterDevice(
      printerDeviceId,
      {
        reason: 'Operator verified paper jam and cleared lease',
        forceReconcileLease: true
      },
      superadmin,
      prisma
    );

    // Re-enable device so status is ACTIVE again
    await prisma.printerDevice.update({
      where: { id: printerDeviceId },
      data: { status: 'ACTIVE' }
    });

    // Verify lease has releasedAt set
    const leaseAfterForce = await prisma.printerDeviceDispatchLease.findUnique({
      where: { printerDeviceId }
    });
    expect(leaseAfterForce.releasedAt).not.toBeNull();

    // Now, Job 2 attempts dispatch authorization
    const socket = { userType: 'printer', machineId, emit: jest.fn() };
    const job2Result = await authorizePrinterDeviceDispatch({
      socket,
      prisma,
      request: {
        requestId: 'req_candidate_02',
        jobId: job2.shortId,
        printerDeviceId,
        windowsPrinterName
      }
    });

    // Invariant: Job 2 MUST be refused because prior Job 1 outcome remains unverified in PRINTING
    expect(job2Result.accepted).toBe(false);
    expect(job2Result.code).toBe('DEVICE_UNRESOLVED_DISPATCH_LEASE');
    expect(socket.emit).toHaveBeenCalledWith('printer_device_dispatch_authorization_result', expect.objectContaining({
      allowed: false,
      code: 'DEVICE_UNRESOLVED_DISPATCH_LEASE'
    }));
  });

  test('proves a legitimately resolved job allows subsequent dispatch on the physical device', async () => {
    const job1 = await createTestJob('job_to_be_resolved_01', 'PRINTING');
    const job2 = await createTestJob('job_waiting_for_clearance_02', 'PRINTING');

    // Job 1 has an expired, released lease
    await prisma.printerDeviceDispatchLease.upsert({
      where: { printerDeviceId },
      create: {
        printerDeviceId,
        requestId: 'req_res_01',
        jobShortId: job1.shortId,
        expiresAt: new Date(Date.now() - 60000),
        releasedAt: new Date(Date.now() - 30000)
      },
      update: {
        requestId: 'req_res_01',
        jobShortId: job1.shortId,
        expiresAt: new Date(Date.now() - 60000),
        releasedAt: new Date(Date.now() - 30000)
      }
    });

    // Operator legitimately resolves Job 1 via updateJobStatus to FAILED (or COMPLETED)
    await updateJobStatus(job1.shortId, 'FAILED', superadmin, { reason: 'Operator physically confirmed paper jam failure' });

    // Verify DB state
    const resolvedJob = await prisma.printJob.findUnique({ where: { shortId: job1.shortId } });
    expect(resolvedJob.status).toBe('FAILED');

    // Now Job 2 attempts dispatch authorization
    const socket = { userType: 'printer', machineId, emit: jest.fn() };
    const job2Result = await authorizePrinterDeviceDispatch({
      socket,
      prisma,
      request: {
        requestId: 'req_clearance_02',
        jobId: job2.shortId,
        printerDeviceId,
        windowsPrinterName
      }
    });

    // Invariant: Job 2 is authorized because prior job reached a terminal status
    expect(job2Result.accepted).toBe(true);
    expect(socket.emit).toHaveBeenCalledWith('printer_device_dispatch_authorization_result', expect.objectContaining({
      allowed: true,
      jobId: job2.shortId
    }));

    const finalLease = await prisma.printerDeviceDispatchLease.findUnique({
      where: { printerDeviceId }
    });
    expect(finalLease.jobShortId).toBe(job2.shortId);
    expect(finalLease.releasedAt).toBeNull();
  });
});
