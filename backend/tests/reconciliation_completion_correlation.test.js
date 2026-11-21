const setupSockets = require('../src/socket');
const prisma = require('../src/utils/prisma');

jest.mock('../src/utils/prisma', () => ({
  printJob: {
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  machine: {
    findUnique: jest.fn().mockResolvedValue(null)
  },
  printerDevice: {
    findMany: jest.fn().mockResolvedValue([])
  },
  printHistory: {
    create: jest.fn()
  },
  reconciliationRecord: {
    create: jest.fn()
  },
  $transaction: jest.fn()
}));

jest.mock('../src/services/printerAvailability.service', () => ({
  getMachineAvailability: jest.fn().mockResolvedValue({ isOnline: true }),
  computePrinterAvailability: jest.fn().mockResolvedValue({ isOnline: true })
}));

jest.mock('../src/services/printerDeviceJobBinding.service', () => ({
  verifyPrinterDeviceReport: jest.fn((job, report) => {
    if (report && report.printerDeviceId && job && job.printerDeviceId) {
      return report.printerDeviceId === job.printerDeviceId;
    }
    return true;
  }),
  authorizePrinterDeviceDispatch: jest.fn(),
  renewPrinterDeviceDispatchLease: jest.fn(),
  releasePrinterDeviceDispatchLease: jest.fn()
}));

class MockSocketIO {
  constructor() {
    this.connectionHandlers = [];
    this.emittedEvents = [];
  }
  use() {}
  on(event, handler) {
    if (event === 'connection') {
      this.connectionHandlers.push(handler);
    }
  }
  to() {
    return {
      emit: (event, data) => {
        this.emittedEvents.push({ event, data });
      }
    };
  }
  emit(event, data) {
    this.emittedEvents.push({ event, data });
  }
}

class MockSocket {
  constructor(socketId, machineId) {
    this.id = socketId;
    this.userType = 'printer';
    this.machineId = machineId;
    this.handlers = new Map();
    this.sentEvents = [];
    this.rooms = new Set();
    this.pendingReconciliations = new Map();
    this.activeReconciliation = null;
  }
  join(room) {
    this.rooms.add(room);
  }
  on(event, handler) {
    this.handlers.set(event, handler);
  }
  emit(event, data) {
    this.sentEvents.push({ event, data });
  }
  async trigger(event, data) {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler registered for event: ${event}`);
    return await handler(data);
  }
}

describe('Finding 2 — Reconciliation Completion Correlation', () => {
  let io;
  let socketA;
  const machineAId = 'mach_rec_A';
  const machineBId = 'mach_rec_B';
  const jobId = 'job_rec_001';

  beforeEach(() => {
    jest.clearAllMocks();
    setupSockets.clearAllReconciliationState();
    io = new MockSocketIO();
    setupSockets(io);

    socketA = new MockSocket('sock_A', machineAId);
    for (const handler of io.connectionHandlers) {
      handler(socketA);
    }
  });

  test('1. Clearance with reconciled: true without requestId is rejected with print_physical_ambiguous', async () => {
    prisma.printJob.findUnique.mockResolvedValueOnce({
      id: 'db_job_1',
      shortId: jobId,
      machineId: machineAId,
      status: 'PRINTING',
      printerDeviceId: 'dev_epson_01'
    });

    await socketA.trigger('print_spooler_cleared', {
      jobId,
      reconciled: true,
      wasSeenInQueue: false
    });

    const ambiguousEvent = socketA.sentEvents.find(e => e.event === 'print_physical_ambiguous');
    expect(ambiguousEvent).toBeDefined();
    expect(ambiguousEvent.data.reason).toMatch(/Missing requestId for reconciliation/);
    expect(prisma.printJob.update).not.toHaveBeenCalled();
  });

  test('2. Clearance with wrong/unregistered requestId is rejected with print_physical_ambiguous', async () => {
    prisma.printJob.findUnique.mockResolvedValueOnce({
      id: 'db_job_1',
      shortId: jobId,
      machineId: machineAId,
      status: 'PRINTING',
      printerDeviceId: 'dev_epson_01'
    });

    await socketA.trigger('print_spooler_cleared', {
      jobId,
      requestId: 'req_unregistered_999',
      reconciled: true,
      wasSeenInQueue: false
    });

    const ambiguousEvent = socketA.sentEvents.find(e => e.event === 'print_physical_ambiguous');
    expect(ambiguousEvent).toBeDefined();
    expect(ambiguousEvent.data.reason).toMatch(/No matching active reconciliation request/);
    expect(prisma.printJob.update).not.toHaveBeenCalled();
  });

  test('3. Clearance with expired requestId (>60s) is rejected with print_physical_ambiguous', async () => {
    const expiredRequestId = 'req_expired_123';
    setupSockets.registerReconciliationOnSocket(socketA, {
      requestId: expiredRequestId,
      jobIds: [jobId]
    });

    // Artificially expire the request (> 60s)
    const entry = socketA.pendingReconciliations.get(expiredRequestId);
    entry.createdAt = Date.now() - 65000;

    prisma.printJob.findUnique.mockResolvedValueOnce({
      id: 'db_job_1',
      shortId: jobId,
      machineId: machineAId,
      status: 'PRINTING',
      printerDeviceId: 'dev_epson_01'
    });

    await socketA.trigger('print_spooler_cleared', {
      jobId,
      requestId: expiredRequestId,
      reconciled: true,
      wasSeenInQueue: false
    });

    const ambiguousEvent = socketA.sentEvents.find(e => e.event === 'print_physical_ambiguous');
    expect(ambiguousEvent).toBeDefined();
    expect(ambiguousEvent.data.reason).toMatch(/Reconciliation request expired/);
    expect(prisma.printJob.update).not.toHaveBeenCalled();
  });

  test('4. Clearance with requestId belonging to a different machine is rejected', async () => {
    const crossRequestId = 'req_machine_B_123';
    // Create an entry owned by machine B
    const crossEntry = {
      requestId: crossRequestId,
      machineId: machineBId,
      jobIds: new Set([jobId]),
      jobBindings: {},
      validatedCompletions: new Map(),
      consumedJobs: new Set(),
      createdAt: Date.now()
    };
    socketA.pendingReconciliations.set(crossRequestId, crossEntry);

    prisma.printJob.findUnique.mockResolvedValueOnce({
      id: 'db_job_1',
      shortId: jobId,
      machineId: machineAId,
      status: 'PRINTING',
      printerDeviceId: 'dev_epson_01'
    });

    await socketA.trigger('print_spooler_cleared', {
      jobId,
      requestId: crossRequestId,
      reconciled: true,
      wasSeenInQueue: false
    });

    const ambiguousEvent = socketA.sentEvents.find(e => e.event === 'print_physical_ambiguous');
    expect(ambiguousEvent).toBeDefined();
    expect(ambiguousEvent.data.reason).toMatch(/Machine mismatch on reconciliation request/);
    expect(prisma.printJob.update).not.toHaveBeenCalled();
  });

  test('5. Clearance for a jobId not included in the reconciliation request is rejected', async () => {
    const validRequestId = 'req_valid_scope_1';
    setupSockets.registerReconciliationOnSocket(socketA, {
      requestId: validRequestId,
      jobIds: ['job_other_in_scope']
    });

    prisma.printJob.findUnique.mockResolvedValueOnce({
      id: 'db_job_1',
      shortId: jobId, // Not in jobIds
      machineId: machineAId,
      status: 'PRINTING',
      printerDeviceId: 'dev_epson_01'
    });

    await socketA.trigger('print_spooler_cleared', {
      jobId,
      requestId: validRequestId,
      reconciled: true,
      wasSeenInQueue: false
    });

    const ambiguousEvent = socketA.sentEvents.find(e => e.event === 'print_physical_ambiguous');
    expect(ambiguousEvent).toBeDefined();
    expect(ambiguousEvent.data.reason).toMatch(/Job not in reconciliation request/);
    expect(prisma.printJob.update).not.toHaveBeenCalled();
  });

  test('6. Multi-printer: Clearance reporting mismatched printer device binding is rejected', async () => {
    const validRequestId = 'req_binding_test_1';
    setupSockets.registerReconciliationOnSocket(socketA, {
      requestId: validRequestId,
      jobIds: [jobId],
      jobBindings: {
        [jobId]: { printerDeviceId: 'dev_expected_epson' }
      }
    });

    prisma.printJob.findUnique.mockResolvedValueOnce({
      id: 'db_job_1',
      shortId: jobId,
      machineId: machineAId,
      status: 'PRINTING',
      printerDeviceId: 'dev_expected_epson'
    });

    // Report specifies dev_wrong_device
    await socketA.trigger('print_spooler_cleared', {
      jobId,
      requestId: validRequestId,
      printerDeviceId: 'dev_wrong_device',
      reconciled: true,
      wasSeenInQueue: false
    });

    const ambiguousEvent = socketA.sentEvents.find(e => e.event === 'print_physical_ambiguous');
    expect(ambiguousEvent).toBeDefined();
    expect(prisma.printJob.update).not.toHaveBeenCalled();
  });

  test('7. Replayed completion report for the same requestId and jobId is rejected', async () => {
    const validRequestId = 'req_replay_test_1';
    setupSockets.registerReconciliationOnSocket(socketA, {
      requestId: validRequestId,
      jobIds: [jobId]
    });

    const mockJob = {
      id: 'db_job_1',
      shortId: jobId,
      machineId: machineAId,
      status: 'PRINTING',
      printerDeviceId: 'dev_epson_01'
    };

    prisma.printJob.findUnique.mockResolvedValue(mockJob);
    prisma.printJob.update.mockResolvedValueOnce({
      ...mockJob,
      status: 'COMPLETED'
    });
    prisma.printHistory.create.mockResolvedValueOnce({ id: 'hist_1' });

    // First clearance report -> succeeds
    await socketA.trigger('print_spooler_cleared', {
      jobId,
      requestId: validRequestId,
      reconciled: true,
      wasSeenInQueue: true
    });

    expect(prisma.printJob.update).toHaveBeenCalledTimes(1);
    expect(prisma.printHistory.create).toHaveBeenCalledTimes(1);
    expect(socketA.sentEvents.some(e => e.event === 'ack_job_completed')).toBe(true);

    // Second replay clearance report with same requestId and jobId -> rejected
    await socketA.trigger('print_spooler_cleared', {
      jobId,
      requestId: validRequestId,
      reconciled: true,
      wasSeenInQueue: true
    });

    const replayAmbiguous = socketA.sentEvents.find(e =>
      e.event === 'print_physical_ambiguous' && e.data?.reason?.includes('Replayed completion report')
    );
    expect(replayAmbiguous).toBeDefined();
    // Update should not be called a second time
    expect(prisma.printJob.update).toHaveBeenCalledTimes(1);
  });

  test('8. Simulation-mode completion is rejected when backend environment is production', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalAppEnv = process.env.APP_ENV;
    const originalAllowSim = process.env.ALLOW_SIMULATED_PRINTER;

    process.env.NODE_ENV = 'production';
    process.env.APP_ENV = 'production';
    delete process.env.ALLOW_SIMULATED_PRINTER;

    try {
      prisma.printJob.findUnique.mockResolvedValueOnce({
        id: 'db_job_1',
        shortId: jobId,
        machineId: machineAId,
        status: 'PRINTING',
        printerDeviceId: 'dev_epson_01'
      });

      await socketA.trigger('print_spooler_cleared', {
        jobId,
        mode: 'simulation',
        wasSeenInQueue: false
      });

      const ambiguousEvent = socketA.sentEvents.find(e => e.event === 'print_physical_ambiguous');
      expect(ambiguousEvent).toBeDefined();
      expect(ambiguousEvent.data.reason).toMatch(/Simulation mode not permitted in current environment/);
      expect(prisma.printJob.update).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalEnv;
      process.env.APP_ENV = originalAppEnv;
      if (originalAllowSim !== undefined) process.env.ALLOW_SIMULATED_PRINTER = originalAllowSim;
    }
  });

  test('9. Valid COMPLETED_LOCALLY state machine flow succeeds: starting from PRINTING satisfies state machine and completes', async () => {
    const validRequestId = 'req_completed_locally_1';
    setupSockets.registerReconciliationOnSocket(socketA, {
      requestId: validRequestId,
      jobIds: [jobId]
    });

    const mockDbJob = {
      id: 'db_job_cl_1',
      shortId: jobId,
      machineId: machineAId,
      status: 'PRINTING',
      printerDeviceId: 'dev_epson_01',
      payment: { status: 'SUCCESS' }
    };

    // Step 1: Agent reports COMPLETED_LOCALLY for in-flight PRINTING job
    prisma.$transaction.mockImplementationOnce(async (cb) => {
      return cb({
        printJob: {
          findUnique: jest.fn().mockResolvedValue(mockDbJob)
        }
      });
    });

    await socketA.trigger('job_reconciliation_report', {
      requestId: validRequestId,
      jobId,
      status: 'COMPLETED_LOCALLY',
      printerDeviceId: 'dev_epson_01'
    });

    // Verify it was moved to validatedCompletions
    const activeReq = socketA.pendingReconciliations.get(validRequestId);
    expect(activeReq.validatedCompletions.has(jobId)).toBe(true);
    expect(activeReq.jobIds.has(jobId)).toBe(false);

    // Step 2: Agent emits matching print_spooler_cleared
    prisma.printJob.findUnique.mockResolvedValueOnce(mockDbJob);
    prisma.printJob.update.mockResolvedValueOnce({
      ...mockDbJob,
      status: 'COMPLETED'
    });
    prisma.printHistory.create.mockResolvedValueOnce({ id: 'hist_cl_1' });

    await socketA.trigger('print_spooler_cleared', {
      jobId,
      requestId: validRequestId,
      reconciled: true,
      wasSeenInQueue: true,
      printerDeviceId: 'dev_epson_01'
    });

    expect(prisma.printJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { shortId: jobId },
      data: { status: 'COMPLETED' }
    }));

    expect(prisma.printHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        printJobId: mockDbJob.id,
        success: true,
        errorDetails: expect.stringContaining('Reconciled via agent journal evidence')
      })
    }), expect.anything());

    expect(socketA.sentEvents.some(e => e.event === 'ack_job_completed' && e.data?.jobId === jobId)).toBe(true);
    // Request entry is fully consumed and pruned
    expect(socketA.pendingReconciliations.has(validRequestId)).toBe(false);
  });

  test('10. COMPLETED_LOCALLY for job in WAITING state is strictly rejected (violates state machine; never dispatched)', async () => {
    const validRequestId = 'req_waiting_reconciliation_1';
    setupSockets.registerReconciliationOnSocket(socketA, {
      requestId: validRequestId,
      jobIds: [jobId]
    });

    const mockWaitingJob = {
      id: 'db_job_waiting_1',
      shortId: jobId,
      machineId: machineAId,
      status: 'WAITING', // Not yet claimed or dispatched
      printerDeviceId: 'dev_epson_01',
      payment: { status: 'SUCCESS' }
    };

    // Agent attempts to report COMPLETED_LOCALLY on undispatched WAITING job
    prisma.$transaction.mockImplementationOnce(async (cb) => {
      return cb({
        printJob: {
          findUnique: jest.fn().mockResolvedValue(mockWaitingJob)
        }
      });
    });

    await socketA.trigger('job_reconciliation_report', {
      requestId: validRequestId,
      jobId,
      status: 'COMPLETED_LOCALLY',
      printerDeviceId: 'dev_epson_01'
    });

    // Verification 1: Report is rejected; NOT promoted to validatedCompletions
    const activeReq = socketA.pendingReconciliations.get(validRequestId);
    expect(activeReq.validatedCompletions.has(jobId)).toBe(false);
    // Request slot remains in jobIds for valid resolution
    expect(activeReq.jobIds.has(jobId)).toBe(true);

    // Verification 2: Even if agent tries to emit print_spooler_cleared on WAITING job, it cannot complete
    prisma.printJob.findUnique.mockResolvedValueOnce(mockWaitingJob);

    await socketA.trigger('print_spooler_cleared', {
      jobId,
      requestId: validRequestId,
      reconciled: true,
      wasSeenInQueue: true,
      printerDeviceId: 'dev_epson_01'
    });

    // Database must NOT update to COMPLETED (WAITING -> COMPLETED is forbidden by state machine)
    expect(prisma.printJob.update).not.toHaveBeenCalled();
    expect(prisma.printHistory.create).not.toHaveBeenCalled();
    expect(socketA.sentEvents.some(e => e.event === 'ack_job_completed')).toBe(false);
  });
});
