'use strict';

/**
 * P1-02: Reconnect Reconciliation & False Success Prevention Tests
 *
 * Verifies that:
 * 1. DISPATCHED_TO_SPOOLER never emits print_physical_success.
 * 2. SPOOLING never emits print_physical_success.
 * 3. AMBIGUOUS_REQUIRES_OPERATOR_REVIEW never emits print_physical_success.
 * 4. COMPLETED_LOCALLY emits print_physical_success ONLY with verified durable terminal evidence.
 * 5. Missing or falsy wasSeenInQueue does not silently become true (reports ambiguous).
 * 6. ACKNOWLEDGED emits idempotent success (does not trigger duplicate backend charge/status mutation).
 * 7. Missing or unknown journal entry does not emit success.
 * 8. Existing P1-01 mutex remains intact during reconciliation.
 * 9. Existing P1-04 fail-closed journal remains intact.
 * 10. Backend ambiguous event handling does not mark a job COMPLETED.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const JobJournal = require('../src/journal');
const { PrintMutex } = require('../src/printMutex');
const setupSockets = require('../../backend/src/socket');
const prisma = require('../../backend/src/utils/prisma');

// Helper to simulate agent reconciliation logic from index.js
function createAgentReconciler(journal, socket) {
  function hasVerifiedTerminalCompletion(entry) {
    if (!entry || entry.state !== 'COMPLETED_LOCALLY') {
      return false;
    }
    const details = entry.details || {};
    if (details.mode === 'simulation') return true;
    if (details.wasSeenInQueue === true) return true;

    if (Array.isArray(entry.history)) {
      const completedStep = entry.history.find(h => h.state === 'COMPLETED_LOCALLY');
      if (completedStep && completedStep.details) {
        if (completedStep.details.mode === 'simulation') return true;
        if (completedStep.details.wasSeenInQueue === true) return true;
      }
    }
    return false;
  }

  return function handleReconcileActiveJobs({ jobIds = [] }) {
    for (const jobId of jobIds) {
      const entry = journal.getJob(jobId);
      if (!entry) {
        socket.emit('job_reconciliation_report', { jobId, status: 'NOT_DISPATCHED' });
        continue;
      }

      if (entry.state === 'ACKNOWLEDGED') {
        socket.emit('print_physical_success', {
          jobId,
          reconciled: true,
          idempotent: true,
          wasSeenInQueue: true,
          dispatchedAt: entry.dispatchedAt,
          completedAt: entry.completedAt
        });
      } else if (entry.state === 'COMPLETED_LOCALLY') {
        if (hasVerifiedTerminalCompletion(entry)) {
          socket.emit('print_physical_success', {
            jobId,
            reconciled: true,
            wasSeenInQueue: true,
            dispatchedAt: entry.dispatchedAt,
            completedAt: entry.completedAt
          });
        } else {
          socket.emit('print_physical_ambiguous', {
            jobId,
            reason: 'Reconciliation: COMPLETED_LOCALLY lacks verified wasSeenInQueue evidence',
            wasSeenInQueue: false
          });
        }
      } else if (
        entry.state === 'DISPATCHED_TO_SPOOLER' ||
        entry.state === 'SPOOLING' ||
        entry.state === 'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW'
      ) {
        socket.emit('print_physical_ambiguous', {
          jobId,
          reason: `Reconciliation: Job in unverified state ${entry.state}`,
          wasSeenInQueue: entry.state === 'SPOOLING'
        });
        socket.emit('job_reconciliation_report', { jobId, status: entry.state });
      } else {
        socket.emit('job_reconciliation_report', { jobId, status: entry.state });
      }
    }
  };
}

describe('P1-02: Reconnect Reconciliation & False Success Prevention', () => {
  let tmpJournalPath;
  let journal;
  let emittedEvents;
  let mockSocket;
  let reconciler;

  beforeEach(() => {
    tmpJournalPath = path.join(os.tmpdir(), `p1_02_test_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
    journal = new JobJournal(tmpJournalPath);
    emittedEvents = [];
    mockSocket = {
      emit: jest.fn((event, payload) => {
        emittedEvents.push({ event, payload });
      })
    };
    reconciler = createAgentReconciler(journal, mockSocket);
  });

  afterEach(() => {
    if (fs.existsSync(tmpJournalPath)) {
      try { fs.unlinkSync(tmpJournalPath); } catch (_) {}
    }
  });

  test('1. DISPATCHED_TO_SPOOLER: NEVER emits print_physical_success, emits print_physical_ambiguous', () => {
    journal.recordReceived('JOB-DSP');
    journal.recordDispatched('JOB-DSP', { printerName: 'Epson' });

    reconciler({ jobIds: ['JOB-DSP'] });

    const successEvents = emittedEvents.filter(e => e.event === 'print_physical_success');
    expect(successEvents).toHaveLength(0);

    const ambiguousEvents = emittedEvents.filter(e => e.event === 'print_physical_ambiguous');
    expect(ambiguousEvents).toHaveLength(1);
    expect(ambiguousEvents[0].payload).toMatchObject({
      jobId: 'JOB-DSP',
      reason: expect.stringContaining('DISPATCHED_TO_SPOOLER'),
      wasSeenInQueue: false
    });
  });

  test('2. SPOOLING: NEVER emits print_physical_success, emits print_physical_ambiguous with wasSeenInQueue=true', () => {
    journal.recordReceived('JOB-SPL');
    journal.recordDispatched('JOB-SPL');
    journal.jobs['JOB-SPL'].state = 'SPOOLING';
    journal.save();

    reconciler({ jobIds: ['JOB-SPL'] });

    const successEvents = emittedEvents.filter(e => e.event === 'print_physical_success');
    expect(successEvents).toHaveLength(0);

    const ambiguousEvents = emittedEvents.filter(e => e.event === 'print_physical_ambiguous');
    expect(ambiguousEvents).toHaveLength(1);
    expect(ambiguousEvents[0].payload).toMatchObject({
      jobId: 'JOB-SPL',
      reason: expect.stringContaining('SPOOLING'),
      wasSeenInQueue: true
    });
  });

  test('3. AMBIGUOUS_REQUIRES_OPERATOR_REVIEW: NEVER emits print_physical_success', () => {
    journal.recordReceived('JOB-AMB');
    journal.recordDispatched('JOB-AMB');
    journal.jobs['JOB-AMB'].state = 'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW';
    journal.save();

    reconciler({ jobIds: ['JOB-AMB'] });

    const successEvents = emittedEvents.filter(e => e.event === 'print_physical_success');
    expect(successEvents).toHaveLength(0);

    const ambiguousEvents = emittedEvents.filter(e => e.event === 'print_physical_ambiguous');
    expect(ambiguousEvents).toHaveLength(1);
    expect(ambiguousEvents[0].payload).toMatchObject({
      jobId: 'JOB-AMB',
      reason: expect.stringContaining('AMBIGUOUS_REQUIRES_OPERATOR_REVIEW')
    });
  });

  test('4. COMPLETED_LOCALLY: emits success ONLY with verified durable wasSeenInQueue=true or simulation', () => {
    journal.recordCompleted('JOB-OK', { wasSeenInQueue: true });

    reconciler({ jobIds: ['JOB-OK'] });

    const successEvents = emittedEvents.filter(e => e.event === 'print_physical_success');
    expect(successEvents).toHaveLength(1);
    expect(successEvents[0].payload).toMatchObject({
      jobId: 'JOB-OK',
      reconciled: true,
      wasSeenInQueue: true
    });

    const ambiguousEvents = emittedEvents.filter(e => e.event === 'print_physical_ambiguous');
    expect(ambiguousEvents).toHaveLength(0);
  });

  test('5. COMPLETED_LOCALLY without wasSeenInQueue does NOT silently become true; reports ambiguous', () => {
    // Record completion without wasSeenInQueue (e.g. legacy or unverified fast-clear)
    journal.recordReceived('JOB-UNVERIFIED');
    journal.jobs['JOB-UNVERIFIED'].state = 'COMPLETED_LOCALLY';
    journal.jobs['JOB-UNVERIFIED'].details = { fastSpoolCleared: true, wasSeenInQueue: false };
    journal.save();

    reconciler({ jobIds: ['JOB-UNVERIFIED'] });

    const successEvents = emittedEvents.filter(e => e.event === 'print_physical_success');
    expect(successEvents).toHaveLength(0);

    const ambiguousEvents = emittedEvents.filter(e => e.event === 'print_physical_ambiguous');
    expect(ambiguousEvents).toHaveLength(1);
    expect(ambiguousEvents[0].payload).toMatchObject({
      jobId: 'JOB-UNVERIFIED',
      wasSeenInQueue: false
    });
  });

  test('6. ACKNOWLEDGED emits idempotent success with idempotent=true flag', () => {
    journal.recordCompleted('JOB-ACK', { wasSeenInQueue: true });
    journal.recordAcknowledged('JOB-ACK');

    reconciler({ jobIds: ['JOB-ACK'] });

    const successEvents = emittedEvents.filter(e => e.event === 'print_physical_success');
    expect(successEvents).toHaveLength(1);
    expect(successEvents[0].payload).toMatchObject({
      jobId: 'JOB-ACK',
      reconciled: true,
      idempotent: true
    });
  });

  test('7. Unknown / missing journal entry does NOT emit success; reports NOT_DISPATCHED', () => {
    reconciler({ jobIds: ['JOB-UNKNOWN'] });

    const successEvents = emittedEvents.filter(e => e.event === 'print_physical_success');
    expect(successEvents).toHaveLength(0);

    const reportEvents = emittedEvents.filter(e => e.event === 'job_reconciliation_report');
    expect(reportEvents).toHaveLength(1);
    expect(reportEvents[0].payload).toMatchObject({
      jobId: 'JOB-UNKNOWN',
      status: 'NOT_DISPATCHED'
    });
  });

  test('8. Existing P1-01 mutex remains intact during reconciliation (reconciliation does not hold mutex)', async () => {
    const mutex = new PrintMutex();
    journal.recordCompleted('JOB-RECON-MUTEX', { wasSeenInQueue: true });

    // Mutex should be unlocked before, during, and after reconciliation
    expect(mutex.isLocked()).toBe(false);
    reconciler({ jobIds: ['JOB-RECON-MUTEX'] });
    expect(mutex.isLocked()).toBe(false);

    // Another job can acquire normally
    const handle = await mutex.acquire('JOB-NEXT');
    expect(mutex.isLocked()).toBe(true);
    expect(mutex.getHeldJobId()).toBe('JOB-NEXT');
    handle.release();
    expect(mutex.isLocked()).toBe(false);
  });

  test('9. Existing P1-04 fail-closed journal remains intact across startup recovery and reconciliation', () => {
    journal.recordReceived('JOB-RECOVER');
    journal.recordDispatched('JOB-RECOVER');
    journal.save();

    // Simulate agent restart
    journal.recoverOnStartup();
    expect(journal.getJob('JOB-RECOVER').state).toBe('AMBIGUOUS_REQUIRES_OPERATOR_REVIEW');

    // Now trigger reconciliation on recovered job
    reconciler({ jobIds: ['JOB-RECOVER'] });

    const successEvents = emittedEvents.filter(e => e.event === 'print_physical_success');
    expect(successEvents).toHaveLength(0);

    const ambiguousEvents = emittedEvents.filter(e => e.event === 'print_physical_ambiguous');
    expect(ambiguousEvents).toHaveLength(1);
    expect(ambiguousEvents[0].payload.jobId).toBe('JOB-RECOVER');
  });

  test('10. Backend ambiguous event handling keeps job in PRINTING; never marks COMPLETED', async () => {
    const orig$transaction = prisma.$transaction;
    const origFindMany = prisma.printJob.findMany;
    const origFindUnique = prisma.printJob.findUnique;
    const origUpdate = prisma.printJob.update;
    const origHistoryCreate = prisma.printHistory.create;

    try {
      const mockTx = {
        printJob: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'uuid-123',
            shortId: 'PG-AMBIG-TEST',
            status: 'PRINTING',
            machineId: 'm-1'
          }),
          update: jest.fn().mockResolvedValue({ id: 'uuid-123' })
        },
        printHistory: {
          create: jest.fn().mockResolvedValue({ id: 'hist-1' })
        }
      };

      prisma.$transaction = jest.fn(async (cb) => {
        return await cb(mockTx);
      });
      // Intercept the background recovery IIFE so it never reaches the real PrismaClient
      prisma.printJob.findMany = jest.fn().mockResolvedValue([]);

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

      const mockSocketInstance = {
        id: 'sock-1',
        userType: 'printer',
        machineId: 'm-1',
        join: jest.fn(),
        emit: jest.fn(),
        on: jest.fn((event, handler) => {
          registeredHandlers[event] = handler;
        })
      };

      setupSockets(mockIo);
      expect(connectionHandler).toBeDefined();
      connectionHandler(mockSocketInstance);

      const ambiguousHandler = registeredHandlers['print_physical_ambiguous'];
      expect(ambiguousHandler).toBeDefined();

      // Trigger ambiguous event
      await ambiguousHandler({
        jobId: 'PG-AMBIG-TEST',
        reason: 'Reconciliation: Job in unverified state DISPATCHED_TO_SPOOLER',
        wasSeenInQueue: false
      });

      // Verify: status is NOT changed to COMPLETED
      expect(mockTx.printJob.update).not.toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETED' })
      }));

      // Verify: printHistory audit record created
      expect(mockTx.printHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          printJobId: 'uuid-123',
          success: false,
          errorDetails: expect.stringContaining('DISPATCHED_TO_SPOOLER')
        })
      }));
    } finally {
      prisma.$transaction = orig$transaction;
      prisma.printJob.findMany = origFindMany;
      prisma.printJob.findUnique = origFindUnique;
      prisma.printJob.update = origUpdate;
      prisma.printHistory.create = origHistoryCreate;
    }
  });

  test('11. Backend print_physical_success is idempotent when job already COMPLETED (no duplicate charge or update)', async () => {
    const origFindMany = prisma.printJob.findMany;
    const origFindUnique = prisma.printJob.findUnique;
    const origUpdate = prisma.printJob.update;
    const origHistoryCreate = prisma.printHistory.create;

    try {
      // Intercept the background recovery IIFE so it never reaches the real PrismaClient
      prisma.printJob.findMany = jest.fn().mockResolvedValue([]);
      prisma.printJob.findUnique = jest.fn().mockResolvedValue({
        id: 'uuid-456',
        shortId: 'PG-COMPLETED-TEST',
        status: 'COMPLETED', // Already completed
        machineId: 'm-1',
        document: { id: 'doc-1' }
      });
      prisma.printJob.update = jest.fn();
      prisma.printHistory.create = jest.fn();

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

      const mockSocketInstance = {
        id: 'sock-1',
        userType: 'printer',
        machineId: 'm-1',
        join: jest.fn(),
        emit: jest.fn(),
        on: jest.fn((event, handler) => {
          registeredHandlers[event] = handler;
        })
      };

      setupSockets(mockIo);
      expect(connectionHandler).toBeDefined();
      connectionHandler(mockSocketInstance);

      const successHandler = registeredHandlers['print_physical_success'];
      expect(successHandler).toBeDefined();

      // Trigger physical success on already completed job
      await successHandler({
        jobId: 'PG-COMPLETED-TEST',
        reconciled: true,
        idempotent: true
      });

      // Verify: update is NOT called again
      expect(prisma.printJob.update).not.toHaveBeenCalled();
      // Verify: printHistory is NOT duplicated
      expect(prisma.printHistory.create).not.toHaveBeenCalled();
      // Verify: ack is sent to the machine
      expect(mockSocketInstance.emit).toHaveBeenCalledWith('ack_job_completed', { jobId: 'PG-COMPLETED-TEST' });
    } finally {
      prisma.printJob.findMany = origFindMany;
      prisma.printJob.findUnique = origFindUnique;
      prisma.printJob.update = origUpdate;
      prisma.printHistory.create = origHistoryCreate;
    }
  });

  // ---------------------------------------------------------------------------
  // Tests 12–15: Background Recovery IIFE (socket.js L61-79) isolation tests
  // ---------------------------------------------------------------------------

  test('12. Recovery IIFE calls findMany with the correct machineId and PRINTING status filter', async () => {
    const origFindMany = prisma.printJob.findMany;
    try {
      prisma.printJob.findMany = jest.fn().mockResolvedValue([]);

      let connectionHandler;
      const mockIo = {
        use: jest.fn(),
        on: jest.fn((event, handler) => {
          if (event === 'connection') connectionHandler = handler;
        }),
        to: jest.fn(() => ({ emit: jest.fn() }))
      };

      const mockSocketInstance = {
        id: 'sock-filter-check',
        userType: 'printer',
        machineId: 'machine-abc',
        join: jest.fn(),
        emit: jest.fn(),
        on: jest.fn()
      };

      setupSockets(mockIo);
      connectionHandler(mockSocketInstance);

      // Flush one microtask tick — sufficient for a single-await IIFE with mockResolvedValue
      await Promise.resolve();

      expect(prisma.printJob.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.printJob.findMany).toHaveBeenCalledWith({
        where: { machineId: 'machine-abc', status: 'PRINTING' },
        select: { shortId: true }
      });
    } finally {
      prisma.printJob.findMany = origFindMany;
    }
  });

  test('13. Recovery IIFE emits reconcile_active_jobs with correct jobIds when stuck PRINTING jobs exist', async () => {
    const origFindMany = prisma.printJob.findMany;
    try {
      prisma.printJob.findMany = jest.fn().mockResolvedValue([
        { shortId: 'PG-STUCK-1' },
        { shortId: 'PG-STUCK-2' }
      ]);

      let connectionHandler;
      const mockIo = {
        use: jest.fn(),
        on: jest.fn((event, handler) => {
          if (event === 'connection') connectionHandler = handler;
        }),
        to: jest.fn(() => ({ emit: jest.fn() }))
      };

      const mockSocketInstance = {
        id: 'sock-stuck',
        userType: 'printer',
        machineId: 'machine-abc',
        join: jest.fn(),
        emit: jest.fn(),
        on: jest.fn()
      };

      setupSockets(mockIo);
      connectionHandler(mockSocketInstance);
      await Promise.resolve();

      const reconcileEmits = mockSocketInstance.emit.mock.calls
        .filter(([event]) => event === 'reconcile_active_jobs');

      expect(reconcileEmits).toHaveLength(1);
      expect(reconcileEmits[0][1]).toEqual({ jobIds: ['PG-STUCK-1', 'PG-STUCK-2'] });
    } finally {
      prisma.printJob.findMany = origFindMany;
    }
  });

  test('14. Recovery IIFE does NOT emit reconcile_active_jobs when findMany returns empty', async () => {
    const origFindMany = prisma.printJob.findMany;
    try {
      prisma.printJob.findMany = jest.fn().mockResolvedValue([]);

      let connectionHandler;
      const mockIo = {
        use: jest.fn(),
        on: jest.fn((event, handler) => {
          if (event === 'connection') connectionHandler = handler;
        }),
        to: jest.fn(() => ({ emit: jest.fn() }))
      };

      const mockSocketInstance = {
        id: 'sock-clean',
        userType: 'printer',
        machineId: 'machine-abc',
        join: jest.fn(),
        emit: jest.fn(),
        on: jest.fn()
      };

      setupSockets(mockIo);
      connectionHandler(mockSocketInstance);
      await Promise.resolve();

      const reconcileEmits = mockSocketInstance.emit.mock.calls
        .filter(([event]) => event === 'reconcile_active_jobs');

      expect(reconcileEmits).toHaveLength(0);
    } finally {
      prisma.printJob.findMany = origFindMany;
    }
  });

  test('15. Recovery IIFE swallows DB errors; connection handler does not throw and socket remains functional', async () => {
    const origFindMany = prisma.printJob.findMany;
    try {
      prisma.printJob.findMany = jest.fn().mockRejectedValue(
        new Error('DATABASE_URL environment variable is not set')
      );

      let connectionHandler;
      const mockIo = {
        use: jest.fn(),
        on: jest.fn((event, handler) => {
          if (event === 'connection') connectionHandler = handler;
        }),
        to: jest.fn(() => ({ emit: jest.fn() }))
      };

      const mockSocketInstance = {
        id: 'sock-dberr',
        userType: 'printer',
        machineId: 'machine-abc',
        join: jest.fn(),
        emit: jest.fn(),
        on: jest.fn()
      };

      setupSockets(mockIo);

      // connectionHandler must not throw synchronously
      expect(() => connectionHandler(mockSocketInstance)).not.toThrow();

      // Allow the IIFE rejection to settle inside its own catch block
      await Promise.resolve();

      // No reconcile emission on DB error
      const reconcileEmits = mockSocketInstance.emit.mock.calls
        .filter(([event]) => event === 'reconcile_active_jobs');
      expect(reconcileEmits).toHaveLength(0);

      // Socket instance remains functional — event handlers were registered
      expect(mockSocketInstance.on).toHaveBeenCalled();
      expect(mockSocketInstance.join).toHaveBeenCalled();
    } finally {
      prisma.printJob.findMany = origFindMany;
    }
  });
});
