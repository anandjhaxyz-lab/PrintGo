const mockPrisma = {
  printJob: {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  printHistory: {
    create: jest.fn().mockResolvedValue({ id: 'hist-1' })
  },
  reconciliationRecord: {
    findFirst: jest.fn(),
    create: jest.fn().mockResolvedValue({ id: 'rec-1' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 })
  },
  machine: {
    findUnique: jest.fn().mockResolvedValue({ id: 'mach-1', name: 'Kiosk 1' }),
    update: jest.fn()
  },
  printerStatus: {
    create: jest.fn()
  },
  $transaction: jest.fn((cb) => cb(mockPrisma))
};

jest.mock('../src/utils/prisma', () => mockPrisma);

jest.mock('../src/services/refund.service', () => ({
  createRefund: jest.fn(),
  getRefunds: jest.fn(),
  getRefundById: jest.fn()
}));

jest.mock('../src/modules/payments/payments.service', () => ({
  refundPayment: jest.fn()
}));

const prisma = require('../src/utils/prisma');
const queueService = require('../src/services/queueService');
const setupSockets = require('../src/socket');

const createMockSocket = (overrides = {}) => {
  const registeredHandlers = {};
  const socket = {
    id: 'sock-1',
    userType: 'printer',
    machineId: 'mach-1',
    machineName: 'Kiosk 1',
    handshake: { auth: { machineKey: 'mock_key' } },
    join: jest.fn(),
    emit: jest.fn(),
    on: jest.fn((event, handler) => {
      registeredHandlers[event] = handler;
    }),
    registeredHandlers,
    ...overrides
  };
  return socket;
};

describe('PR #19 Safety Followup: Ambiguous Printing & Spooler Clearance Safety', () => {
  const refundService = require('../src/services/refund.service');
  const paymentsService = require('../src/modules/payments/payments.service');

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.printJob.findMany.mockResolvedValue([]);
  });

  describe('1. Stuck PRINTING Job Safety (queueService.reconcileStuckPrintingJobs)', () => {
    test('never marks stuck PRINTING job as FAILED and never initiates refund', async () => {
      const fifteenMinsAgo = new Date(Date.now() - 20 * 60000);
      const mockStuckJob = {
        id: 'job-stuck-1',
        shortId: 'stuck001',
        status: 'PRINTING',
        paymentId: 'pay-stuck-1',
        machineId: 'mach-1',
        printerDeviceId: 'dev-1',
        printerWindowsQueueName: 'EPSON_L3150',
        updatedAt: fifteenMinsAgo,
        payment: { id: 'pay-stuck-1', status: 'SUCCESS', amount: 50.0 },
        printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' },
        machine: { id: 'mach-1', companyId: 'comp-1' }
      };

      prisma.printJob.findMany.mockResolvedValueOnce([mockStuckJob]);
      prisma.reconciliationRecord.findFirst.mockResolvedValueOnce(null);

      const mockIo = {
        to: jest.fn().mockReturnValue({ emit: jest.fn() })
      };

      const result = await queueService.reconcileStuckPrintingJobs({
        prismaClient: prisma,
        io: mockIo,
        now: Date.now(),
        thresholdMs: 15 * 60000
      });

      expect(result.scannedCount).toBe(1);
      expect(result.failClosedRetainedCount).toBe(1);

      // CRITICAL ASSERTION: PrintJob.update to FAILED must NEVER be called
      expect(prisma.printJob.update).not.toHaveBeenCalled();

      // CRITICAL ASSERTION: Automated refund must NEVER be called
      expect(refundService.createRefund).not.toHaveBeenCalled();
      expect(paymentsService.refundPayment).not.toHaveBeenCalled();

      // Structured incident record must be created
      expect(prisma.reconciliationRecord.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          printJobId: 'job-stuck-1',
          paymentId: 'pay-stuck-1',
          status: 'MANUAL_REVIEW_REQUIRED',
          discrepancyType: 'STUCK_PRINTING_JOB'
        })
      }));

      // Agent journal reconciliation must be requested via websocket
      expect(mockIo.to).toHaveBeenCalledWith('machine_mach-1');
      expect(mockIo.to('machine_mach-1').emit).toHaveBeenCalledWith('reconcile_active_jobs', expect.objectContaining({
        jobIds: ['stuck001']
      }));
    });

    test('retains fail-closed state when agent is offline or io is null', async () => {
      const mockStuckJob = {
        id: 'job-stuck-2',
        shortId: 'stuck002',
        status: 'PRINTING',
        paymentId: 'pay-stuck-2',
        machineId: 'mach-offline',
        updatedAt: new Date(Date.now() - 30 * 60000)
      };

      prisma.printJob.findMany.mockResolvedValueOnce([mockStuckJob]);
      prisma.reconciliationRecord.findFirst.mockResolvedValueOnce({ id: 'existing-rec' });

      const result = await queueService.reconcileStuckPrintingJobs({
        prismaClient: prisma,
        io: null, // Offline agent
        now: Date.now()
      });

      expect(result.failClosedRetainedCount).toBe(1);
      expect(prisma.printJob.update).not.toHaveBeenCalled();
      expect(refundService.createRefund).not.toHaveBeenCalled();
    });
  });

  describe('2. Post-Handoff Physical Error Handling (socket.js)', () => {
    test('print_physical_error after spooler handoff retains PRINTING and suppresses automatic refund', async () => {
      const mockSocket = createMockSocket();
      const mockIo = {
        use: jest.fn(),
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
        on: jest.fn((event, cb) => {
          if (event === 'connection') cb(mockSocket);
        })
      };

      setupSockets(mockIo);

      const currentJob = {
        id: 'job-phys-err-1',
        shortId: 'err001',
        status: 'PRINTING', // In-flight after driver handoff
        machineId: 'mach-1',
        paymentId: 'pay-err-1',
        printerDeviceId: 'dev-1',
        printerWindowsQueueName: 'EPSON_L3150',
        payment: { id: 'pay-err-1', status: 'SUCCESS' },
        printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' }
      };

      prisma.printJob.findUnique.mockResolvedValueOnce(currentJob);

      // Simulate agent reporting post-handoff error (e.g. PaperJam while printing)
      const errorHandler = mockSocket.registeredHandlers['print_physical_error'];
      expect(typeof errorHandler).toBe('function');

      await errorHandler({
        jobId: 'err001',
        error: 'PaperJam',
        printerDeviceId: 'dev-1',
        windowsPrinterName: 'EPSON_L3150'
      });

      // CRITICAL ASSERTION: Job must NOT be marked FAILED
      expect(prisma.printJob.update).not.toHaveBeenCalled();

      // CRITICAL ASSERTION: Automatic refund must NOT be initiated
      expect(paymentsService.refundPayment).not.toHaveBeenCalled();
      expect(refundService.createRefund).not.toHaveBeenCalled();

      // Ambiguous PrintHistory must be recorded
      expect(prisma.printHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          printJobId: 'job-phys-err-1',
          success: false,
          errorDetails: expect.stringContaining('PaperJam')
        })
      }));

      // ReconciliationRecord must be logged
      expect(prisma.reconciliationRecord.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          printJobId: 'job-phys-err-1',
          status: 'MANUAL_REVIEW_REQUIRED',
          discrepancyType: 'POST_HANDOFF_PHYSICAL_ERROR'
        })
      }));
    });
  });

  describe('3. Spooler Clearance Semantics (print_spooler_cleared)', () => {
    test('print_spooler_cleared verifies machine and device ownership and marks COMPLETED with truthful evidence', async () => {
      const mockSocket = createMockSocket();
      const mockIo = {
        use: jest.fn(),
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
        on: jest.fn((event, cb) => {
          if (event === 'connection') cb(mockSocket);
        })
      };

      setupSockets(mockIo);

      const currentJob = {
        id: 'job-clear-1',
        shortId: 'clear001',
        status: 'PRINTING',
        machineId: 'mach-1',
        printerDeviceId: 'dev-1',
        printerWindowsQueueName: 'EPSON_L3150',
        printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' }
      };

      prisma.printJob.findUnique.mockResolvedValueOnce(currentJob);
      prisma.printJob.update.mockResolvedValueOnce({
        ...currentJob,
        status: 'COMPLETED'
      });

      const handler = mockSocket.registeredHandlers['print_spooler_cleared'];
      expect(typeof handler).toBe('function');

      await handler({
        jobId: 'clear001',
        wasSeenInQueue: true,
        printerDeviceId: 'dev-1',
        windowsPrinterName: 'EPSON_L3150'
      });

      // Status transitioned to COMPLETED
      expect(prisma.printJob.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { shortId: 'clear001' },
        data: { status: 'COMPLETED' }
      }));

      // Truthful PrintHistory text: spooler transmission/queue clearance confirmed, NOT sensor physical ejection
      expect(prisma.printHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            printJobId: 'job-clear-1',
            success: true,
            errorDetails: expect.stringContaining('Windows spooler transmission and queue clearance confirmed')
          })
        }),
        expect.anything()
      );

      // Acknowledged to agent
      expect(mockSocket.emit).toHaveBeenCalledWith('ack_job_completed', { jobId: 'clear001' });
    });

    test('refuses spooler clearance when queue was never observed (wasSeenInQueue: false)', async () => {
      const mockSocket = createMockSocket();
      const mockIo = {
        use: jest.fn(),
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
        on: jest.fn((event, cb) => {
          if (event === 'connection') cb(mockSocket);
        })
      };

      setupSockets(mockIo);

      const currentJob = {
        id: 'job-unseen-1',
        shortId: 'unseen001',
        status: 'PRINTING',
        machineId: 'mach-1',
        printerDeviceId: 'dev-1',
        printerWindowsQueueName: 'EPSON_L3150',
        printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' }
      };

      prisma.printJob.findUnique.mockResolvedValueOnce(currentJob);

      const handler = mockSocket.registeredHandlers['print_spooler_cleared'];
      await handler({
        jobId: 'unseen001',
        wasSeenInQueue: false, // Never observed in queue!
        printerDeviceId: 'dev-1',
        windowsPrinterName: 'EPSON_L3150'
      });

      // Must NOT be marked COMPLETED
      expect(prisma.printJob.update).not.toHaveBeenCalled();

      // Must report ambiguous back to agent
      expect(mockSocket.emit).toHaveBeenCalledWith('print_physical_ambiguous', expect.objectContaining({
        jobId: 'unseen001',
        wasSeenInQueue: false
      }));
    });

    test('duplicate spooler clearance event is idempotent and does not create duplicate history', async () => {
      const mockSocket = createMockSocket();
      const mockIo = {
        use: jest.fn(),
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
        on: jest.fn((event, cb) => {
          if (event === 'connection') cb(mockSocket);
        })
      };

      setupSockets(mockIo);

      const completedJob = {
        id: 'job-already-comp',
        shortId: 'comp001',
        status: 'COMPLETED', // Already completed
        machineId: 'mach-1',
        printerDeviceId: 'dev-1',
        printerWindowsQueueName: 'EPSON_L3150',
        printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' }
      };

      prisma.printJob.findUnique.mockResolvedValueOnce(completedJob);

      const handler = mockSocket.registeredHandlers['print_spooler_cleared'];
      await handler({
        jobId: 'comp001',
        wasSeenInQueue: true,
        printerDeviceId: 'dev-1',
        windowsPrinterName: 'EPSON_L3150'
      });

      // No update
      expect(prisma.printJob.update).not.toHaveBeenCalled();
      // No duplicate history entry
      expect(prisma.printHistory.create).not.toHaveBeenCalled();
      // Simply acknowledge to agent
      expect(mockSocket.emit).toHaveBeenCalledWith('ack_job_completed', { jobId: 'comp001' });
    });

    test('rejects spooler clearance when machineId does not match (tenant boundary)', async () => {
      const mockSocket = createMockSocket({ machineId: 'mach-alien' });
      const mockIo = {
        use: jest.fn(),
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
        on: jest.fn((event, cb) => {
          if (event === 'connection') cb(mockSocket);
        })
      };

      setupSockets(mockIo);

      const currentJob = {
        id: 'job-alien-1',
        shortId: 'alien001',
        status: 'PRINTING',
        machineId: 'mach-legit',
        printerDeviceId: 'dev-1',
        printerWindowsQueueName: 'EPSON_L3150',
        printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' }
      };

      prisma.printJob.findUnique.mockResolvedValueOnce(currentJob);

      const handler = mockSocket.registeredHandlers['print_spooler_cleared'];
      await handler({
        jobId: 'alien001',
        wasSeenInQueue: true,
        printerDeviceId: 'dev-1',
        windowsPrinterName: 'EPSON_L3150'
      });

      expect(prisma.printJob.update).not.toHaveBeenCalled();
      expect(mockSocket.emit).not.toHaveBeenCalledWith('ack_job_completed', expect.any(Object));
    });
  });
});
