const jobsService = require('../src/modules/jobs/jobs.service');
const paymentsService = require('../src/modules/payments/payments.service');
const refundService = require('../src/services/refund.service');
const prisma = require('../src/utils/prisma');
const { authorizePrinterDeviceDispatch } = require('../src/services/printerDeviceJobBinding.service');

jest.mock('../src/utils/prisma', () => ({
  printJob: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  printHistory: {
    create: jest.fn()
  },
  activityLog: {
    create: jest.fn()
  },
  payment: {
    findUnique: jest.fn()
  },
  printerDeviceDispatchLease: {
    findUnique: jest.fn(),
    upsert: jest.fn()
  },
  $transaction: jest.fn()
}));

jest.mock('../src/services/refund.service', () => ({
  createRefund: jest.fn()
}));

describe('P1 Job Status & Physical Verification Security Remediation', () => {
  const superadmin = { id: 'admin-01', role: 'SUPERADMIN', email: 'admin@printgo.test' };
  const franchisee = { id: 'fran-01', role: 'FRANCHISEE', companyId: 'comp-100', email: 'fran@printgo.test' };
  const crossFranchisee = { id: 'fran-02', role: 'FRANCHISEE', companyId: 'comp-999', email: 'intruder@printgo.test' };
  const staff = { id: 'staff-01', role: 'STAFF', companyId: 'comp-100', email: 'staff@printgo.test' };

  const baseJob = {
    id: 'job-uuid-101',
    shortId: 'job101',
    status: 'PRINTING',
    machineId: 'mach-01',
    printerDeviceId: 'dev-epson-01',
    printerWindowsQueueName: 'Epson L6460',
    machine: {
      id: 'mach-01',
      name: 'Kiosk Alpha',
      companyId: 'comp-100'
    },
    payment: {
      id: 'pay-uuid-101',
      status: 'SUCCESS',
      amount: 50
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'true';
  });

  // -------------------------------------------------------------------------
  // 1. PRINTING → COMPLETED without authorized physical confirmation: rejected
  // -------------------------------------------------------------------------
  it('1. PRINTING -> COMPLETED without authorized physical confirmation is rejected', async () => {
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PRINTING' });

    // Missing physicalConfirmation flag
    await expect(
      jobsService.updateJobStatus('job101', 'COMPLETED', superadmin, {
        reason: 'Customer said it was done printing'
      })
    ).rejects.toThrow('Authorized physical confirmation is required');

    // Spooler empty only
    await expect(
      jobsService.updateJobStatus('job101', 'COMPLETED', superadmin, {
        reason: 'Windows queue has 0 jobs remaining',
        physicalConfirmation: true,
        spoolerEmptyOnly: true
      })
    ).rejects.toThrow('Spooler-empty status alone is insufficient evidence');
  });

  // -------------------------------------------------------------------------
  // 2. PRINTING → FAILED without authorized resolution: rejected
  // -------------------------------------------------------------------------
  it('2. PRINTING -> FAILED without authorized resolution reason is rejected', async () => {
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PRINTING' });

    // Missing reason
    await expect(
      jobsService.updateJobStatus('job101', 'FAILED', superadmin, {})
    ).rejects.toThrow('An operator reason of at least 10 non-whitespace characters is required');

    // Short reason (<10 chars)
    await expect(
      jobsService.updateJobStatus('job101', 'FAILED', superadmin, { reason: 'failed' })
    ).rejects.toThrow('An operator reason of at least 10 non-whitespace characters is required');
  });

  // -------------------------------------------------------------------------
  // 3. STAFF attempting ambiguous job resolution: rejected
  // -------------------------------------------------------------------------
  it('3. STAFF attempting ambiguous job resolution is rejected with 403', async () => {
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PRINTING' });

    // STAFF attempting COMPLETED
    await expect(
      jobsService.updateJobStatus('job101', 'COMPLETED', staff, {
        physicalConfirmation: true,
        reason: 'Staff checked the printer tray'
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('Ordinary STAFF status updates cannot resolve jobs in PRINTING status')
    });

    // STAFF attempting FAILED
    await expect(
      jobsService.updateJobStatus('job101', 'FAILED', staff, {
        reason: 'Staff saw paper jam in printer'
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('Ordinary STAFF status updates cannot resolve jobs in PRINTING status')
    });
  });

  // -------------------------------------------------------------------------
  // 4. FRANCHISEE attempting cross-tenant job resolution: rejected
  // -------------------------------------------------------------------------
  it('4. FRANCHISEE attempting cross-tenant job resolution is rejected with 403', async () => {
    // Job belongs to comp-100, crossFranchisee belongs to comp-999
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PRINTING' });

    await expect(
      jobsService.updateJobStatus('job101', 'COMPLETED', crossFranchisee, {
        physicalConfirmation: true,
        reason: 'Intruder operator verified physical document'
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('Access denied: Job belongs to another company')
    });
  });

  // -------------------------------------------------------------------------
  // 5. Invalid state transition: rejected
  // -------------------------------------------------------------------------
  it('5. Invalid state transitions are rejected with 400', async () => {
    // PENDING_PAYMENT -> COMPLETED (invalid)
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PENDING_PAYMENT' });
    await expect(
      jobsService.updateJobStatus('job101', 'COMPLETED', superadmin)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Invalid status transition from "PENDING_PAYMENT" to "COMPLETED"')
    });

    // WAITING -> COMPLETED (invalid)
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'WAITING' });
    await expect(
      jobsService.updateJobStatus('job101', 'COMPLETED', superadmin)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Invalid status transition from "WAITING" to "COMPLETED"')
    });

    // COMPLETED -> FAILED (terminal state cannot transition)
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'COMPLETED' });
    await expect(
      jobsService.updateJobStatus('job101', 'FAILED', superadmin)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Invalid status transition from "COMPLETED" to "FAILED"')
    });

    // PRINTING -> CANCELLED (cannot directly cancel printing job)
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PRINTING' });
    await expect(
      jobsService.updateJobStatus('job101', 'CANCELLED', superadmin)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Invalid status transition from "PRINTING" to "CANCELLED"')
    });
  });

  // -------------------------------------------------------------------------
  // 6. Authorized physical completion with valid audit information: accepted
  // -------------------------------------------------------------------------
  it('6. Authorized physical completion with valid audit information is accepted', async () => {
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PRINTING' });

    const mockUpdatedJob = { ...baseJob, status: 'COMPLETED' };
    const mockTx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: baseJob.id }]),
      printJob: {
        update: jest.fn().mockResolvedValue(mockUpdatedJob)
      },
      printHistory: {
        create: jest.fn().mockResolvedValue({ id: 'hist-01' })
      },
      activityLog: {
        create: jest.fn().mockResolvedValue({ id: 'act-01' })
      }
    };
    prisma.$transaction.mockImplementation(async (cb) => cb(mockTx));

    const result = await jobsService.updateJobStatus('job101', 'COMPLETED', franchisee, {
      physicalConfirmation: true,
      reason: 'Physical verification confirmed: all 5 pages cleanly collected from tray'
    });

    expect(result.status).toBe('COMPLETED');
    expect(mockTx.printJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: baseJob.id },
        data: { status: 'COMPLETED' }
      })
    );
    expect(mockTx.printHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        printJobId: baseJob.id,
        success: true,
        errorDetails: expect.stringContaining('Physical verification confirmed by operator')
      })
    });
    expect(mockTx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PRINT_JOB_STATUS_RESOLVED',
        userId: franchisee.id,
        machineId: baseJob.machineId,
        details: expect.stringContaining('"physicalConfirmation":true')
      })
    });
  });

  // -------------------------------------------------------------------------
  // 7. Authorized failed-job resolution with appropriate evidence: accepted
  // -------------------------------------------------------------------------
  it('7. Authorized failed-job resolution with appropriate evidence is accepted', async () => {
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PRINTING' });

    const mockUpdatedJob = { ...baseJob, status: 'FAILED' };
    const mockTx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: baseJob.id }]),
      printJob: {
        update: jest.fn().mockResolvedValue(mockUpdatedJob)
      },
      printHistory: {
        create: jest.fn().mockResolvedValue({ id: 'hist-02' })
      },
      activityLog: {
        create: jest.fn().mockResolvedValue({ id: 'act-02' })
      }
    };
    prisma.$transaction.mockImplementation(async (cb) => cb(mockTx));

    const result = await jobsService.updateJobStatus('job101', 'FAILED', franchisee, {
      reason: 'Physical inspection confirmed paper jam in tray; document was not printed'
    });

    expect(result.status).toBe('FAILED');
    expect(mockTx.printJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: baseJob.id },
        data: { status: 'FAILED' }
      })
    );
    expect(mockTx.printHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        printJobId: baseJob.id,
        success: false,
        errorDetails: expect.stringContaining('Physical inspection failure resolved by operator')
      })
    });
    expect(mockTx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PRINT_JOB_STATUS_RESOLVED',
        userId: franchisee.id,
        machineId: baseJob.machineId,
        details: expect.stringContaining('"newStatus":"FAILED"')
      })
    });
  });

  // -------------------------------------------------------------------------
  // 8. Missing or short operator reason: rejected
  // -------------------------------------------------------------------------
  it('8. Missing, whitespace-only, or short (<10 char) operator reasons are rejected', async () => {
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PRINTING' });

    // Whitespace only
    await expect(
      jobsService.updateJobStatus('job101', 'FAILED', superadmin, { reason: '          ' })
    ).rejects.toThrow('An operator reason of at least 10 non-whitespace characters is required');

    // 9 characters
    await expect(
      jobsService.updateJobStatus('job101', 'FAILED', superadmin, { reason: '123456789' })
    ).rejects.toThrow('An operator reason of at least 10 non-whitespace characters is required');

    // Exactly 10 non-whitespace characters is accepted
    const mockTx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: baseJob.id }]),
      printJob: { update: jest.fn().mockResolvedValue({ ...baseJob, status: 'FAILED' }) },
      printHistory: { create: jest.fn().mockResolvedValue({}) },
      activityLog: { create: jest.fn().mockResolvedValue({}) }
    };
    prisma.$transaction.mockImplementation(async (cb) => cb(mockTx));

    await expect(
      jobsService.updateJobStatus('job101', 'FAILED', superadmin, { reason: '1234567890' })
    ).resolves.toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 9. Ambiguous job remains PRINTING and dispatch remains blocked
  // -------------------------------------------------------------------------
  it('9. Ambiguous job remains in PRINTING and blocks subsequent dispatch', async () => {
    // When a lease exists with previous job in PRINTING status:
    const mockTx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'dev-epson-01' }]),
      printJob: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.shortId === 'job101') {
            return Promise.resolve({ id: 'job-uuid-101', shortId: 'job101', status: 'PRINTING' });
          }
          if (where.shortId === 'job102') {
            return Promise.resolve({
              id: 'job-uuid-102',
              shortId: 'job102',
              status: 'PRINTING',
              machineId: 'mach-01',
              printerDeviceId: 'dev-epson-01',
              printerWindowsQueueName: 'Epson L6460',
              printerDevice: {
                id: 'dev-epson-01',
                machineId: 'mach-01',
                windowsPrinterName: 'Epson L6460',
                status: 'ACTIVE',
                approvedAt: new Date()
              }
            });
          }
          return Promise.resolve(null);
        })
      },
      printerDeviceDispatchLease: {
        findUnique: jest.fn().mockResolvedValue({
          printerDeviceId: 'dev-epson-01',
          requestId: 'req-old',
          jobShortId: 'job101',
          expiresAt: new Date(Date.now() - 60000), // expired lease
          releasedAt: new Date(Date.now() - 30000) // released/force-reconciled lease
        })
      }
    };

    const mockPrismaInstance = {
      $transaction: jest.fn(async (cb) => cb(mockTx))
    };

    const socket = { userType: 'printer', machineId: 'mach-01', emit: jest.fn() };
    const dispatchResult = await authorizePrinterDeviceDispatch({
      socket,
      prisma: mockPrismaInstance,
      request: {
        requestId: 'req-new-002',
        jobId: 'job102',
        printerDeviceId: 'dev-epson-01',
        windowsPrinterName: 'Epson L6460'
      }
    });

    // Invariant: New job cannot dispatch while prior job is PRINTING
    expect(dispatchResult.accepted).toBe(false);
    expect(dispatchResult.code).toBe('DEVICE_UNRESOLVED_DISPATCH_LEASE');
  });

  // -------------------------------------------------------------------------
  // 10. No duplicate or missing ActivityLog/PrintHistory records
  // -------------------------------------------------------------------------
  it('10. No duplicate or missing ActivityLog/PrintHistory records created', async () => {
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PRINTING' });

    const mockTx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: baseJob.id }]),
      printJob: { update: jest.fn().mockResolvedValue({ ...baseJob, status: 'FAILED' }) },
      printHistory: { create: jest.fn().mockResolvedValue({ id: 'hist-single' }) },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'act-single' }) }
    };
    prisma.$transaction.mockImplementation(async (cb) => cb(mockTx));

    // Valid resolution creates exactly 1 history and 1 activity record
    await jobsService.updateJobStatus('job101', 'FAILED', superadmin, {
      reason: 'Physical inspection verified paper feed mechanism jammed'
    });

    expect(mockTx.printHistory.create).toHaveBeenCalledTimes(1);
    expect(mockTx.activityLog.create).toHaveBeenCalledTimes(1);

    // Failed validation throws BEFORE entering transaction: 0 records
    jest.clearAllMocks();
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PRINTING' });

    await expect(
      jobsService.updateJobStatus('job101', 'FAILED', superadmin, { reason: 'short' })
    ).rejects.toThrow();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mockTx.printHistory.create).not.toHaveBeenCalled();
    expect(mockTx.activityLog.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 11. Concurrent status resolution versus new dispatch authorization
  // -------------------------------------------------------------------------
  it('11. Status resolution serializes with dispatch authorization and unblocks once resolved', async () => {
    let job1State = 'PRINTING';

    const mockTx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'dev-epson-01' }]),
      printJob: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.shortId === 'job101') {
            return Promise.resolve({ id: 'job-uuid-101', shortId: 'job101', status: job1State });
          }
          if (where.shortId === 'job102') {
            return Promise.resolve({
              id: 'job-uuid-102',
              shortId: 'job102',
              status: 'PRINTING',
              machineId: 'mach-01',
              printerDeviceId: 'dev-epson-01',
              printerWindowsQueueName: 'Epson L6460',
              printerDevice: {
                id: 'dev-epson-01',
                machineId: 'mach-01',
                windowsPrinterName: 'Epson L6460',
                status: 'ACTIVE',
                approvedAt: new Date()
              }
            });
          }
          return Promise.resolve(null);
        }),
        update: jest.fn().mockImplementation(({ data }) => {
          job1State = data.status;
          return Promise.resolve({ ...baseJob, status: data.status });
        })
      },
      printerDeviceDispatchLease: {
        findUnique: jest.fn().mockResolvedValue({
          printerDeviceId: 'dev-epson-01',
          requestId: 'req-old',
          jobShortId: 'job101',
          expiresAt: new Date(Date.now() - 60000),
          releasedAt: new Date(Date.now() - 30000)
        }),
        upsert: jest.fn().mockResolvedValue({
          printerDeviceId: 'dev-epson-01',
          jobShortId: 'job102',
          releasedAt: null
        })
      },
      printHistory: { create: jest.fn().mockResolvedValue({}) },
      activityLog: { create: jest.fn().mockResolvedValue({}) }
    };

    const mockPrismaInstance = {
      $transaction: jest.fn(async (cb) => cb(mockTx))
    };

    const socket = { userType: 'printer', machineId: 'mach-01', emit: jest.fn() };

    // Step A: Dispatch while job1 is PRINTING is blocked
    const dispatch1 = await authorizePrinterDeviceDispatch({
      socket,
      prisma: mockPrismaInstance,
      request: {
        requestId: 'req-new-001',
        jobId: 'job102',
        printerDeviceId: 'dev-epson-01',
        windowsPrinterName: 'Epson L6460'
      }
    });
    expect(dispatch1.accepted).toBe(false);
    expect(dispatch1.code).toBe('DEVICE_UNRESOLVED_DISPATCH_LEASE');

    // Step B: Operator resolves job1 to COMPLETED with physical confirmation
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PRINTING' });
    prisma.$transaction.mockImplementation(async (cb) => cb(mockTx));

    await jobsService.updateJobStatus('job101', 'COMPLETED', superadmin, {
      physicalConfirmation: true,
      reason: 'Physical confirmation verified customer collected all pages'
    });
    expect(job1State).toBe('COMPLETED');

    // Step C: Subsequent dispatch attempt now succeeds!
    const dispatch2 = await authorizePrinterDeviceDispatch({
      socket,
      prisma: mockPrismaInstance,
      request: {
        requestId: 'req-new-002',
        jobId: 'job102',
        printerDeviceId: 'dev-epson-01',
        windowsPrinterName: 'Epson L6460'
      }
    });
    expect(dispatch2.accepted).toBe(true);
    expect(socket.emit).toHaveBeenLastCalledWith(
      'printer_device_dispatch_authorization_result',
      expect.objectContaining({ allowed: true, requestId: 'req-new-002' })
    );
  });

  // -------------------------------------------------------------------------
  // 12. Existing payment, refund and customer mobile workflows remain functional
  // -------------------------------------------------------------------------
  it('12. Existing payment, refund and mobile transitions remain fully consistent', async () => {
    // A: Legitimate PENDING_PAYMENT -> WAITING succeeds
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PENDING_PAYMENT' });
    prisma.printJob.update.mockResolvedValue({ ...baseJob, status: 'WAITING' });

    const waitingJob = await jobsService.updateJobStatus('job101', 'WAITING', staff);
    expect(waitingJob.status).toBe('WAITING');

    // B: Legitimate WAITING -> CANCELLED succeeds
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'WAITING' });
    prisma.printJob.update.mockResolvedValue({ ...baseJob, status: 'CANCELLED' });

    const cancelledJob = await jobsService.updateJobStatus('job101', 'CANCELLED', staff);
    expect(cancelledJob.status).toBe('CANCELLED');

    // C: COMPLETED job cannot be refunded via ordinary failure refund
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'COMPLETED' });
    await expect(
      paymentsService.refundPayment('job101', superadmin)
    ).rejects.toThrow('Completed jobs cannot be refunded through the failure workflow');

    // D: PRINTING job cannot be refunded before resolution
    prisma.printJob.findUnique.mockResolvedValue({ ...baseJob, status: 'PRINTING' });
    await expect(
      paymentsService.refundPayment('job101', superadmin)
    ).rejects.toThrow('Cannot refund a job currently in PRINTING status. Resolve the physical print outcome first.');

    // E: Legitimate FAILED job can be refunded and transitions to CANCELLED
    const failedJob = { ...baseJob, status: 'FAILED' };
    prisma.printJob.findUnique.mockResolvedValue(failedJob);
    refundService.createRefund.mockResolvedValue({
      id: 'ref-01',
      status: 'SUCCESS',
      amount: 50
    });
    prisma.payment.findUnique.mockResolvedValue({ id: 'pay-uuid-101', status: 'REFUNDED' });
    prisma.printJob.update.mockResolvedValue({ ...failedJob, status: 'CANCELLED' });

    const refundResult = await paymentsService.refundPayment('job101', superadmin, 'Customer refund for failed print');
    expect(refundResult.status).toBe('CANCELLED');
    expect(refundResult.refund.status).toBe('SUCCESS');
  });
});
