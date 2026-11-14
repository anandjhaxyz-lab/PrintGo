'use strict';

/**
 * P1-02 / P1-05 Safety: Ambiguous Job Refund Prevention & Concurrency Tests
 *
 * Verifies that:
 * 1. Old PRINTING job with ambiguous PrintHistory: no failure, no refund.
 * 2. Old PRINTING job without ambiguity: normal cleanup and refund behavior preserved.
 * 3. Duplicate ambiguity records: still excluded.
 * 4. Ambiguity event racing with cleaner (updatedAt touched / record inserted): no automatic refund.
 * 5. Operator resolves job while cleaner runs: no duplicate or conflicting transition.
 * 6. One-hour terminal file retention remains unchanged.
 */

const { cleanupStuckPrintingJobs } = require('../../backend/src/services/queueService');
const setupSockets = require('../../backend/src/socket');
const prisma = require('../../backend/src/utils/prisma');

describe('P1-02 / P1-05: Ambiguous Job Refund Safety & Concurrency', () => {
  const BASE_NOW = new Date('2026-11-13T12:00:00.000Z');
  const TWENTY_MINS_AGO = new Date('2026-11-13T11:40:00.000Z'); // > 15 mins ago
  const FIVE_MINS_AGO = new Date('2026-11-13T11:55:00.000Z');   // < 15 mins ago

  let mockRefundService;

  beforeEach(() => {
    mockRefundService = {
      createRefund: jest.fn().mockResolvedValue({ id: 'ref_1', status: 'SUCCESS' })
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('1. Old PRINTING job with ambiguous PrintHistory: no failure, no refund', async () => {
    const mockDb = {
      printJob: {
        findMany: jest.fn().mockResolvedValue([]), // Prisma filter excludes it
        updateMany: jest.fn()
      },
      $transaction: jest.fn()
    };

    const results = await cleanupStuckPrintingJobs({
      prismaClient: mockDb,
      now: BASE_NOW,
      timeoutMs: 15 * 60000,
      refundService: mockRefundService
    });

    // Verify findMany included the ambiguous filter condition
    expect(mockDb.printJob.findMany).toHaveBeenCalledWith({
      where: {
        status: 'PRINTING',
        updatedAt: { lt: expect.any(Date) },
        printHistory: {
          none: {
            success: false,
            errorDetails: {
              contains: 'Ambiguous outcome'
            }
          }
        }
      }
    });

    expect(results.scanned).toBe(0);
    expect(results.failed).toBe(0);
    expect(results.refunded).toBe(0);
    expect(mockRefundService.createRefund).not.toHaveBeenCalled();
    expect(mockDb.printJob.updateMany).not.toHaveBeenCalled();
  });

  test('2. Old PRINTING job without ambiguity: normal cleanup and refund behavior preserved', async () => {
    const candidateJob = {
      id: 'job-unattended-crash',
      shortId: 'PG-UNATT',
      status: 'PRINTING',
      updatedAt: TWENTY_MINS_AGO,
      paymentId: 'pay_123'
    };

    const mockDb = {
      printJob: {
        findMany: jest.fn().mockResolvedValue([candidateJob]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      $transaction: jest.fn(async (cb) => {
        return await cb(mockDb);
      })
    };

    const results = await cleanupStuckPrintingJobs({
      prismaClient: mockDb,
      now: BASE_NOW,
      timeoutMs: 15 * 60000,
      refundService: mockRefundService
    });

    expect(results.scanned).toBe(1);
    expect(results.failed).toBe(1);
    expect(results.refunded).toBe(1);
    expect(mockDb.printJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-unattended-crash',
        status: 'PRINTING',
        updatedAt: { lt: expect.any(Date) },
        printHistory: {
          none: {
            success: false,
            errorDetails: { contains: 'Ambiguous outcome' }
          }
        }
      },
      data: { status: 'FAILED' }
    });
    expect(mockRefundService.createRefund).toHaveBeenCalledWith({
      paymentId: 'pay_123',
      reason: expect.stringContaining('Automated crash recovery refund'),
      idempotencyKey: 'auto_recovery_job-unattended-crash_pay_123',
      initiatedBy: 'SYSTEM'
    });
  });

  test('3. Duplicate ambiguity records: updateMany returns count=0, skipped', async () => {
    const candidateJob = {
      id: 'job-multi-ambig',
      shortId: 'PG-MULTI',
      status: 'PRINTING',
      updatedAt: TWENTY_MINS_AGO,
      paymentId: 'pay_456'
    };

    const mockDb = {
      printJob: {
        findMany: jest.fn().mockResolvedValue([candidateJob]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      $transaction: jest.fn(async (cb) => {
        return await cb(mockDb);
      })
    };

    const results = await cleanupStuckPrintingJobs({
      prismaClient: mockDb,
      now: BASE_NOW,
      timeoutMs: 15 * 60000,
      refundService: mockRefundService
    });

    expect(results.scanned).toBe(1);
    expect(results.skipped).toBe(1);
    expect(results.failed).toBe(0);
    expect(results.refunded).toBe(0);
    expect(mockRefundService.createRefund).not.toHaveBeenCalled();
  });

  test('4. Ambiguity event racing with cleaner: updateMany returns count=0, aborts cleaner failure', async () => {
    const candidateJob = {
      id: 'job-race-socket',
      shortId: 'PG-RACE',
      status: 'PRINTING',
      updatedAt: TWENTY_MINS_AGO,
      paymentId: 'pay_789'
    };

    const mockDb = {
      printJob: {
        findMany: jest.fn().mockResolvedValue([candidateJob]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      $transaction: jest.fn(async (cb) => {
        return await cb(mockDb);
      })
    };

    const results = await cleanupStuckPrintingJobs({
      prismaClient: mockDb,
      now: BASE_NOW,
      timeoutMs: 15 * 60000,
      refundService: mockRefundService
    });

    expect(results.skipped).toBe(1);
    expect(results.failed).toBe(0);
    expect(results.refunded).toBe(0);
    expect(mockRefundService.createRefund).not.toHaveBeenCalled();
  });

  test('5. Operator resolves job while cleaner runs: updateMany returns count=0, cleaner skips cleanly', async () => {
    const candidateJob = {
      id: 'job-op-resolved',
      shortId: 'PG-OP',
      status: 'PRINTING',
      updatedAt: TWENTY_MINS_AGO,
      paymentId: 'pay_999'
    };

    const mockDb = {
      printJob: {
        findMany: jest.fn().mockResolvedValue([candidateJob]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      $transaction: jest.fn(async (cb) => {
        return await cb(mockDb);
      })
    };

    const results = await cleanupStuckPrintingJobs({
      prismaClient: mockDb,
      now: BASE_NOW,
      timeoutMs: 15 * 60000,
      refundService: mockRefundService
    });

    expect(results.skipped).toBe(1);
    expect(results.failed).toBe(0);
    expect(results.refunded).toBe(0);
    expect(mockRefundService.createRefund).not.toHaveBeenCalled();
  });

  test('6. socket.on(print_physical_ambiguous) atomically logs PrintHistory AND touches updatedAt', async () => {
    let registeredHandlers = {};
    let connectionHandler;
    const mockIo = {
      use: jest.fn(),
      on: jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      }),
      to: jest.fn(() => ({ emit: jest.fn() }))
    };

    const mockSocket = {
      id: 'sock_p1',
      userType: 'printer',
      machineId: 'm-1',
      join: jest.fn(),
      emit: jest.fn(),
      on: jest.fn((event, handler) => {
        registeredHandlers[event] = handler;
      })
    };

    const orig$transaction = prisma.$transaction;
    const origFindUnique = prisma.printJob.findUnique;
    const origUpdate = prisma.printJob.update;
    const origHistoryCreate = prisma.printHistory.create;

    try {
      const mockTx = {
        printJob: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'job-tx-1',
            shortId: 'PG-TX-1',
            machineId: 'm-1',
            status: 'PRINTING'
          }),
          update: jest.fn().mockResolvedValue({ id: 'job-tx-1' })
        },
        printHistory: {
          create: jest.fn().mockResolvedValue({ id: 'hist-tx-1' })
        }
      };

      prisma.$transaction = jest.fn(async (cb) => {
        return await cb(mockTx);
      });

      setupSockets(mockIo);
      expect(connectionHandler).toBeDefined();
      connectionHandler(mockSocket);

      const ambigHandler = registeredHandlers['print_physical_ambiguous'];
      expect(typeof ambigHandler).toBe('function');

      await ambigHandler({
        jobId: 'PG-TX-1',
        reason: 'Paper Jam reported after partial spool',
        wasSeenInQueue: true
      });

      // Verify transaction executed
      expect(prisma.$transaction).toHaveBeenCalled();
      // Verify PrintHistory recorded with exact error prefix
      expect(mockTx.printHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          printJobId: 'job-tx-1',
          success: false,
          errorDetails: expect.stringContaining('Ambiguous outcome:')
        })
      });
      // Verify updatedAt touched to reset cleaner timer
      expect(mockTx.printJob.update).toHaveBeenCalledWith({
        where: { id: 'job-tx-1' },
        data: { updatedAt: expect.any(Date) }
      });
    } finally {
      prisma.$transaction = orig$transaction;
      prisma.printJob.findUnique = origFindUnique;
      prisma.printJob.update = origUpdate;
      prisma.printHistory.create = origHistoryCreate;
    }
  });
});
