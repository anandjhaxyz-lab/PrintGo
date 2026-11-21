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

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

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
    id: `sock-${Math.random().toString(36).substring(7)}`,
    userType: 'printer',
    machineId: 'mach-1',
    machineName: 'Kiosk 1',
    companyId: 'comp-1',
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

const createMockIo = (connectedSockets = []) => {
  const rooms = {};
  const io = {
    use: jest.fn(),
    on: jest.fn((event, handler) => {
      if (event === 'connection') {
        io.connectionHandler = handler;
      }
    }),
    to: jest.fn((room) => {
      if (!rooms[room]) {
        rooms[room] = {
          emit: jest.fn()
        };
      }
      return rooms[room];
    }),
    in: jest.fn((room) => {
      return {
        fetchSockets: jest.fn().mockResolvedValue(
          connectedSockets.filter(s => s.machineId && room === `machine_${s.machineId}`)
        )
      };
    }),
    rooms
  };
  return io;
};

describe('PR #19 Safety Followup: Timer Reconciliation Correlation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    if (typeof setupSockets.clearAllReconciliationState === 'function') {
      setupSockets.clearAllReconciliationState();
    }
  });

  afterEach(() => {
    if (typeof setupSockets.clearAllReconciliationState === 'function') {
      setupSockets.clearAllReconciliationState();
    }
  });

  test('1. Timer creates a request and registers its exact ID before emission', async () => {
    const mockIo = createMockIo();
    setupSockets(mockIo);

    const socket = createMockSocket({ machineId: 'mach-1' });
    mockIo.connectionHandler(socket);

    const fifteenMinsAgo = new Date(Date.now() - 20 * 60000);
    const mockStuckJob = {
      id: 'job-timer-1',
      shortId: 'stuck_timer_01',
      status: 'PRINTING',
      paymentId: 'pay-1',
      machineId: 'mach-1',
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150',
      updatedAt: fifteenMinsAgo,
      payment: { id: 'pay-1', status: 'SUCCESS' },
      printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' },
      machine: { id: 'mach-1', companyId: 'comp-1' }
    };

    mockPrisma.printJob.findMany.mockResolvedValueOnce([mockStuckJob]);
    mockPrisma.reconciliationRecord.findFirst.mockResolvedValueOnce(null);

    const result = await queueService.reconcileStuckPrintingJobs({
      prismaClient: mockPrisma,
      io: mockIo,
      now: Date.now(),
      thresholdMs: 15 * 60000
    });

    expect(result.scannedCount).toBe(1);
    expect(result.reconciliationRequestedCount).toBe(1);

    // Verify emission to room
    expect(mockIo.to).toHaveBeenCalledWith('machine_mach-1');
    const emitCall = mockIo.rooms['machine_mach-1'].emit.mock.calls.find(c => c[0] === 'reconcile_active_jobs');
    expect(emitCall).toBeDefined();

    const payload = emitCall[1];
    expect(payload.jobIds).toEqual(['stuck_timer_01']);
    expect(payload.requestId).toMatch(/^rec_stuck_mach-1_/);

    // Verify correlation was pre-registered on socket
    expect(socket.pendingReconciliations).toBeDefined();
    expect(socket.pendingReconciliations.has(payload.requestId)).toBe(true);
    const registered = socket.pendingReconciliations.get(payload.requestId);
    expect(registered.machineId).toBe('mach-1');
    expect(registered.jobIds.has('stuck_timer_01')).toBe(true);
  });

  test('2. The correct authenticated socket can submit a matching job_reconciliation_report and is no longer rejected as uncorrelated', async () => {
    const mockIo = createMockIo();
    setupSockets(mockIo);

    const socket = createMockSocket({ machineId: 'mach-1' });
    mockIo.connectionHandler(socket);

    const fifteenMinsAgo = new Date(Date.now() - 20 * 60000);
    const mockStuckJob = {
      id: 'job-timer-2',
      shortId: 'stuck_timer_02',
      status: 'PRINTING',
      paymentId: 'pay-2',
      machineId: 'mach-1',
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150',
      updatedAt: fifteenMinsAgo,
      payment: { id: 'pay-2', status: 'SUCCESS' },
      printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' },
      machine: { id: 'mach-1', companyId: 'comp-1' }
    };

    mockPrisma.printJob.findMany.mockResolvedValueOnce([mockStuckJob]);
    mockPrisma.reconciliationRecord.findFirst.mockResolvedValueOnce(null);

    await queueService.reconcileStuckPrintingJobs({
      prismaClient: mockPrisma,
      io: mockIo,
      now: Date.now(),
      thresholdMs: 15 * 60000
    });

    const emitCall = mockIo.rooms['machine_mach-1'].emit.mock.calls.find(c => c[0] === 'reconcile_active_jobs');
    const { requestId } = emitCall[1];

    // Setup DB response for job lookup during report
    mockPrisma.printJob.findUnique.mockResolvedValueOnce({
      ...mockStuckJob,
      printerDevice: { windowsPrinterName: 'EPSON_L3150' }
    });
    mockPrisma.printJob.updateMany.mockResolvedValueOnce({ count: 1 });

    // Agent submits valid NOT_DISPATCHED report
    const reportHandler = socket.registeredHandlers['job_reconciliation_report'];
    expect(reportHandler).toBeDefined();

    await reportHandler({
      requestId,
      jobId: 'stuck_timer_02',
      status: 'NOT_DISPATCHED',
      printerDeviceId: 'dev-1',
      windowsPrinterName: 'EPSON_L3150'
    });

    // Verification: transition was accepted and job restored to WAITING
    expect(mockPrisma.printJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        shortId: 'stuck_timer_02',
        machineId: 'mach-1',
        status: 'PRINTING'
      }),
      data: { status: 'WAITING' }
    }));
  });

  test('3. Wrong request ID is rejected as uncorrelated', async () => {
    const mockIo = createMockIo();
    setupSockets(mockIo);

    const socket = createMockSocket({ machineId: 'mach-1' });
    mockIo.connectionHandler(socket);

    const fifteenMinsAgo = new Date(Date.now() - 20 * 60000);
    const mockStuckJob = {
      id: 'job-timer-3',
      shortId: 'stuck_timer_03',
      status: 'PRINTING',
      paymentId: 'pay-3',
      machineId: 'mach-1',
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150',
      updatedAt: fifteenMinsAgo,
      payment: { id: 'pay-3', status: 'SUCCESS' },
      printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' }
    };

    mockPrisma.printJob.findMany.mockResolvedValueOnce([mockStuckJob]);
    mockPrisma.reconciliationRecord.findFirst.mockResolvedValueOnce(null);

    await queueService.reconcileStuckPrintingJobs({
      prismaClient: mockPrisma,
      io: mockIo,
      now: Date.now(),
      thresholdMs: 15 * 60000
    });

    const reportHandler = socket.registeredHandlers['job_reconciliation_report'];

    // Agent attempts report with wrong / fabricated requestId
    await reportHandler({
      requestId: 'fabricated_request_id_999',
      jobId: 'stuck_timer_03',
      status: 'NOT_DISPATCHED',
      printerDeviceId: 'dev-1',
      windowsPrinterName: 'EPSON_L3150'
    });

    // Verification: updateMany was NOT called
    expect(mockPrisma.printJob.updateMany).not.toHaveBeenCalled();
  });

  test('4. Another machine\'s socket cannot use the request (cross-machine rejection)', async () => {
    const mockIo = createMockIo();
    setupSockets(mockIo);

    // Legit machine socket
    const socketMach1 = createMockSocket({ id: 'sock-legit', machineId: 'mach-1' });
    mockIo.connectionHandler(socketMach1);

    // Attacker machine socket
    const socketMach2 = createMockSocket({ id: 'sock-attacker', machineId: 'mach-2' });
    mockIo.connectionHandler(socketMach2);

    const fifteenMinsAgo = new Date(Date.now() - 20 * 60000);
    const mockStuckJob = {
      id: 'job-timer-4',
      shortId: 'stuck_timer_04',
      status: 'PRINTING',
      paymentId: 'pay-4',
      machineId: 'mach-1',
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150',
      updatedAt: fifteenMinsAgo,
      payment: { id: 'pay-4', status: 'SUCCESS' },
      printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' }
    };

    mockPrisma.printJob.findMany.mockResolvedValueOnce([mockStuckJob]);
    mockPrisma.reconciliationRecord.findFirst.mockResolvedValueOnce(null);

    await queueService.reconcileStuckPrintingJobs({
      prismaClient: mockPrisma,
      io: mockIo,
      now: Date.now(),
      thresholdMs: 15 * 60000
    });

    const emitCall = mockIo.rooms['machine_mach-1'].emit.mock.calls.find(c => c[0] === 'reconcile_active_jobs');
    const { requestId } = emitCall[1];

    // Attacker on machine 2 attempts to claim request
    const attackerReportHandler = socketMach2.registeredHandlers['job_reconciliation_report'];
    await attackerReportHandler({
      requestId,
      jobId: 'stuck_timer_04',
      status: 'NOT_DISPATCHED',
      printerDeviceId: 'dev-1',
      windowsPrinterName: 'EPSON_L3150'
    });

    expect(mockPrisma.printJob.updateMany).not.toHaveBeenCalled();
  });

  test('5. A report for a job outside the request\'s authorized job scope is rejected', async () => {
    const mockIo = createMockIo();
    setupSockets(mockIo);

    const socket = createMockSocket({ machineId: 'mach-1' });
    mockIo.connectionHandler(socket);

    const fifteenMinsAgo = new Date(Date.now() - 20 * 60000);
    const mockStuckJob = {
      id: 'job-timer-5',
      shortId: 'stuck_timer_05',
      status: 'PRINTING',
      paymentId: 'pay-5',
      machineId: 'mach-1',
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150',
      updatedAt: fifteenMinsAgo,
      payment: { id: 'pay-5', status: 'SUCCESS' },
      printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' }
    };

    mockPrisma.printJob.findMany.mockResolvedValueOnce([mockStuckJob]);
    mockPrisma.reconciliationRecord.findFirst.mockResolvedValueOnce(null);

    await queueService.reconcileStuckPrintingJobs({
      prismaClient: mockPrisma,
      io: mockIo,
      now: Date.now(),
      thresholdMs: 15 * 60000
    });

    const emitCall = mockIo.rooms['machine_mach-1'].emit.mock.calls.find(c => c[0] === 'reconcile_active_jobs');
    const { requestId } = emitCall[1];

    const reportHandler = socket.registeredHandlers['job_reconciliation_report'];

    // Agent attempts report for an unrelated job 'unrelated_job_999' using this requestId
    await reportHandler({
      requestId,
      jobId: 'unrelated_job_999',
      status: 'NOT_DISPATCHED',
      printerDeviceId: 'dev-1',
      windowsPrinterName: 'EPSON_L3150'
    });

    expect(mockPrisma.printJob.updateMany).not.toHaveBeenCalled();
  });

  test('6. Expired request (>60s) is rejected', async () => {
    const mockIo = createMockIo();
    setupSockets(mockIo);

    const socket = createMockSocket({ machineId: 'mach-1' });
    mockIo.connectionHandler(socket);

    const fifteenMinsAgo = new Date(Date.now() - 20 * 60000);
    const mockStuckJob = {
      id: 'job-timer-6',
      shortId: 'stuck_timer_06',
      status: 'PRINTING',
      paymentId: 'pay-6',
      machineId: 'mach-1',
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150',
      updatedAt: fifteenMinsAgo,
      payment: { id: 'pay-6', status: 'SUCCESS' },
      printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' }
    };

    mockPrisma.printJob.findMany.mockResolvedValueOnce([mockStuckJob]);
    mockPrisma.reconciliationRecord.findFirst.mockResolvedValueOnce(null);

    await queueService.reconcileStuckPrintingJobs({
      prismaClient: mockPrisma,
      io: mockIo,
      now: Date.now(),
      thresholdMs: 15 * 60000
    });

    const emitCall = mockIo.rooms['machine_mach-1'].emit.mock.calls.find(c => c[0] === 'reconcile_active_jobs');
    const { requestId } = emitCall[1];

    // Fast-forward request createdAt to simulate 65 seconds elapsed
    const entry = socket.pendingReconciliations.get(requestId);
    entry.createdAt = Date.now() - 65000;

    const reportHandler = socket.registeredHandlers['job_reconciliation_report'];

    await reportHandler({
      requestId,
      jobId: 'stuck_timer_06',
      status: 'NOT_DISPATCHED',
      printerDeviceId: 'dev-1',
      windowsPrinterName: 'EPSON_L3150'
    });

    expect(mockPrisma.printJob.updateMany).not.toHaveBeenCalled();
  });

  test('7. Duplicate/replayed report cannot resolve the job twice', async () => {
    const mockIo = createMockIo();
    setupSockets(mockIo);

    const socket = createMockSocket({ machineId: 'mach-1' });
    mockIo.connectionHandler(socket);

    const fifteenMinsAgo = new Date(Date.now() - 20 * 60000);
    const mockStuckJob = {
      id: 'job-timer-7',
      shortId: 'stuck_timer_07',
      status: 'PRINTING',
      paymentId: 'pay-7',
      machineId: 'mach-1',
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150',
      updatedAt: fifteenMinsAgo,
      payment: { id: 'pay-7', status: 'SUCCESS' },
      printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' },
      machine: { id: 'mach-1', companyId: 'comp-1' }
    };

    mockPrisma.printJob.findMany.mockResolvedValueOnce([mockStuckJob]);
    mockPrisma.reconciliationRecord.findFirst.mockResolvedValueOnce(null);

    await queueService.reconcileStuckPrintingJobs({
      prismaClient: mockPrisma,
      io: mockIo,
      now: Date.now(),
      thresholdMs: 15 * 60000
    });

    const emitCall = mockIo.rooms['machine_mach-1'].emit.mock.calls.find(c => c[0] === 'reconcile_active_jobs');
    const { requestId } = emitCall[1];

    mockPrisma.printJob.findUnique.mockResolvedValueOnce({
      ...mockStuckJob,
      printerDevice: { windowsPrinterName: 'EPSON_L3150' }
    });
    mockPrisma.printJob.updateMany.mockResolvedValueOnce({ count: 1 });

    const reportHandler = socket.registeredHandlers['job_reconciliation_report'];

    // 1st Report (Valid)
    await reportHandler({
      requestId,
      jobId: 'stuck_timer_07',
      status: 'NOT_DISPATCHED',
      printerDeviceId: 'dev-1',
      windowsPrinterName: 'EPSON_L3150'
    });
    expect(mockPrisma.printJob.updateMany).toHaveBeenCalledTimes(1);

    // 2nd Replayed Report (Same requestId and jobId)
    await reportHandler({
      requestId,
      jobId: 'stuck_timer_07',
      status: 'NOT_DISPATCHED',
      printerDeviceId: 'dev-1',
      windowsPrinterName: 'EPSON_L3150'
    });
    // Should NOT have been called a second time
    expect(mockPrisma.printJob.updateMany).toHaveBeenCalledTimes(1);
  });

  test('8. Multiple timer requests do not overwrite or invalidate one another unexpectedly', async () => {
    const mockIo = createMockIo();
    setupSockets(mockIo);

    const socket = createMockSocket({ machineId: 'mach-1' });
    mockIo.connectionHandler(socket);

    const fifteenMinsAgo = new Date(Date.now() - 20 * 60000);
    const mockStuckJobA = {
      id: 'job-multi-a',
      shortId: 'stuck_multi_a',
      status: 'PRINTING',
      paymentId: 'pay-a',
      machineId: 'mach-1',
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150',
      updatedAt: fifteenMinsAgo,
      payment: { id: 'pay-a', status: 'SUCCESS' },
      printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' }
    };
    const mockStuckJobB = {
      id: 'job-multi-b',
      shortId: 'stuck_multi_b',
      status: 'PRINTING',
      paymentId: 'pay-b',
      machineId: 'mach-1',
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150',
      updatedAt: fifteenMinsAgo,
      payment: { id: 'pay-b', status: 'SUCCESS' },
      printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' }
    };

    // Cycle 1: Job A
    mockPrisma.printJob.findMany.mockResolvedValueOnce([mockStuckJobA]);
    mockPrisma.reconciliationRecord.findFirst.mockResolvedValueOnce(null);
    await queueService.reconcileStuckPrintingJobs({
      prismaClient: mockPrisma,
      io: mockIo,
      now: Date.now(),
      thresholdMs: 15 * 60000
    });

    const calls1 = mockIo.rooms['machine_mach-1'].emit.mock.calls.filter(c => c[0] === 'reconcile_active_jobs');
    expect(calls1.length).toBe(1);
    const reqId1 = calls1[0][1].requestId;

    // Cycle 2: Job B
    mockPrisma.printJob.findMany.mockResolvedValueOnce([mockStuckJobB]);
    mockPrisma.reconciliationRecord.findFirst.mockResolvedValueOnce(null);
    await queueService.reconcileStuckPrintingJobs({
      prismaClient: mockPrisma,
      io: mockIo,
      now: Date.now() + 1000,
      thresholdMs: 15 * 60000
    });

    const calls2 = mockIo.rooms['machine_mach-1'].emit.mock.calls.filter(c => c[0] === 'reconcile_active_jobs');
    expect(calls2.length).toBe(2);
    const reqId2 = calls2[1][1].requestId;

    expect(reqId1).not.toBe(reqId2);

    // Both requests must coexist in socket.pendingReconciliations
    expect(socket.pendingReconciliations.has(reqId1)).toBe(true);
    expect(socket.pendingReconciliations.has(reqId2)).toBe(true);

    const reportHandler = socket.registeredHandlers['job_reconciliation_report'];

    // Respond to Job A using reqId1 (older request)
    mockPrisma.printJob.findUnique.mockResolvedValueOnce({
      ...mockStuckJobA,
      printerDevice: { windowsPrinterName: 'EPSON_L3150' }
    });
    mockPrisma.printJob.updateMany.mockResolvedValueOnce({ count: 1 });

    await reportHandler({
      requestId: reqId1,
      jobId: 'stuck_multi_a',
      status: 'NOT_DISPATCHED',
      printerDeviceId: 'dev-1',
      windowsPrinterName: 'EPSON_L3150'
    });
    expect(mockPrisma.printJob.updateMany).toHaveBeenCalledTimes(1);

    // Respond to Job B using reqId2 (newer request)
    mockPrisma.printJob.findUnique.mockResolvedValueOnce({
      ...mockStuckJobB,
      printerDevice: { windowsPrinterName: 'EPSON_L3150' }
    });
    mockPrisma.printJob.updateMany.mockResolvedValueOnce({ count: 1 });

    await reportHandler({
      requestId: reqId2,
      jobId: 'stuck_multi_b',
      status: 'NOT_DISPATCHED',
      printerDeviceId: 'dev-1',
      windowsPrinterName: 'EPSON_L3150'
    });
    expect(mockPrisma.printJob.updateMany).toHaveBeenCalledTimes(2);
  });

  test('9. Disconnect cleanup invalidates the socket\'s pending requests', async () => {
    const mockIo = createMockIo();
    setupSockets(mockIo);

    const socket = createMockSocket({ machineId: 'mach-1' });
    mockIo.connectionHandler(socket);

    const fifteenMinsAgo = new Date(Date.now() - 20 * 60000);
    const mockStuckJob = {
      id: 'job-timer-9',
      shortId: 'stuck_timer_09',
      status: 'PRINTING',
      paymentId: 'pay-9',
      machineId: 'mach-1',
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150',
      updatedAt: fifteenMinsAgo,
      payment: { id: 'pay-9', status: 'SUCCESS' },
      printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' }
    };

    mockPrisma.printJob.findMany.mockResolvedValueOnce([mockStuckJob]);
    mockPrisma.reconciliationRecord.findFirst.mockResolvedValueOnce(null);

    await queueService.reconcileStuckPrintingJobs({
      prismaClient: mockPrisma,
      io: mockIo,
      now: Date.now(),
      thresholdMs: 15 * 60000
    });

    expect(socket.pendingReconciliations.size).toBeGreaterThan(0);

    // Trigger disconnect handler
    const disconnectHandler = socket.registeredHandlers['disconnect'];
    expect(disconnectHandler).toBeDefined();

    await disconnectHandler();

    // Verify socket state was cleared
    expect(socket.pendingReconciliations.size).toBe(0);
    expect(socket.activeReconciliation).toBeNull();
  });

  test('10. Initial connection-triggered reconciliation still works seamlessly', async () => {
    const mockIo = createMockIo();
    setupSockets(mockIo);

    const mockStuckJob = {
      shortId: 'stuck_connect_10',
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150'
    };

    mockPrisma.printJob.findMany.mockResolvedValueOnce([mockStuckJob]);

    const socket = createMockSocket({ machineId: 'mach-1' });
    await mockIo.connectionHandler(socket);

    // Give async IIFE a tick to run
    await new Promise(resolve => setImmediate(resolve));

    // Verify reconcile_active_jobs was emitted to socket
    const emitCall = socket.emit.mock.calls.find(c => c[0] === 'reconcile_active_jobs');
    expect(emitCall).toBeDefined();
    const { requestId, jobIds } = emitCall[1];
    expect(jobIds).toEqual(['stuck_connect_10']);

    // Verify correlation was registered
    expect(socket.pendingReconciliations.has(requestId)).toBe(true);
    expect(socket.activeReconciliation.requestId).toBe(requestId);

    // Verify response works
    mockPrisma.printJob.findUnique.mockResolvedValueOnce({
      id: 'job-10',
      shortId: 'stuck_connect_10',
      status: 'PRINTING',
      machineId: 'mach-1',
      payment: { status: 'SUCCESS' },
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150',
      printerDevice: { windowsPrinterName: 'EPSON_L3150' }
    });
    mockPrisma.printJob.updateMany.mockResolvedValueOnce({ count: 1 });

    const reportHandler = socket.registeredHandlers['job_reconciliation_report'];
    await reportHandler({
      requestId,
      jobId: 'stuck_connect_10',
      status: 'NOT_DISPATCHED',
      printerDeviceId: 'dev-1',
      windowsPrinterName: 'EPSON_L3150'
    });

    expect(mockPrisma.printJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        shortId: 'stuck_connect_10',
        status: 'PRINTING'
      }),
      data: { status: 'WAITING' }
    }));
  });

  test('11. Spooler clearance reporting with valid requestId resolves correlation cleanly', async () => {
    const mockIo = createMockIo();
    setupSockets(mockIo);

    const socket = createMockSocket({ machineId: 'mach-1' });
    mockIo.connectionHandler(socket);

    const fifteenMinsAgo = new Date(Date.now() - 20 * 60000);
    const mockStuckJob = {
      id: 'job-timer-11',
      shortId: 'stuck_timer_11',
      status: 'PRINTING',
      paymentId: 'pay-11',
      machineId: 'mach-1',
      printerDeviceId: 'dev-1',
      printerWindowsQueueName: 'EPSON_L3150',
      updatedAt: fifteenMinsAgo,
      payment: { id: 'pay-11', status: 'SUCCESS' },
      printerDevice: { id: 'dev-1', windowsPrinterName: 'EPSON_L3150' },
      machine: { id: 'mach-1', companyId: 'comp-1' }
    };

    mockPrisma.printJob.findMany.mockResolvedValueOnce([mockStuckJob]);
    mockPrisma.reconciliationRecord.findFirst.mockResolvedValueOnce(null);

    await queueService.reconcileStuckPrintingJobs({
      prismaClient: mockPrisma,
      io: mockIo,
      now: Date.now(),
      thresholdMs: 15 * 60000
    });

    const emitCall = mockIo.rooms['machine_mach-1'].emit.mock.calls.find(c => c[0] === 'reconcile_active_jobs');
    const { requestId } = emitCall[1];

    mockPrisma.printJob.findUnique.mockResolvedValueOnce({
      ...mockStuckJob,
      printerDevice: { windowsPrinterName: 'EPSON_L3150' }
    });
    mockPrisma.printJob.update.mockResolvedValueOnce({
      ...mockStuckJob,
      status: 'COMPLETED'
    });

    const spoolerClearedHandler = socket.registeredHandlers['print_spooler_cleared'];
    expect(spoolerClearedHandler).toBeDefined();

    await spoolerClearedHandler({
      requestId,
      jobId: 'stuck_timer_11',
      wasSeenInQueue: true,
      printerDeviceId: 'dev-1',
      windowsPrinterName: 'EPSON_L3150'
    });

    expect(mockPrisma.printJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { shortId: 'stuck_timer_11' },
      data: { status: 'COMPLETED' }
    }));

    // Verify correlation request for this job was consumed
    expect(socket.pendingReconciliations.has(requestId)).toBe(false);
  });
});
