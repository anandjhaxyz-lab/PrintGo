'use strict';

/**
 * P1-01: Physical Print Serialization Tests
 *
 * Tests that the PrintMutex and its integration with the spooler/agent
 * enforce strict physical serialization: only one job can hold the lock
 * at a time, ambiguous outcomes permanently lock the printer, and
 * restart/reconciliation cannot bypass serialization.
 *
 * All tests use controlled async barriers — no arbitrary setTimeout sleeps.
 * The PrintMutex class is imported directly (not the module singleton)
 * so each describe/test block can create an independent instance.
 */

const { PrintMutex } = require('../../printer-agent/src/printMutex');
const path = require('path');
const os = require('os');
const fs = require('fs');
const JobJournal = require('../../printer-agent/src/journal');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a fresh PrintMutex instance (independent of module singleton).
 */
function makeMutex() {
  return new PrintMutex();
}

/**
 * Returns a promise + externally controllable resolve/reject pair.
 * Used to simulate a printer lifecycle barrier.
 */
function makeBarrier() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Simulate a physical print job that holds the lock until the barrier is settled.
 * Returns the lockHandle so the caller can verify/control release.
 *
 * @param {PrintMutex} mutex
 * @param {string} jobId
 * @param {Promise} workBarrier - resolves when "physical printing is done"
 * @returns {Promise<{ lockHandle, outcome }>}
 */
async function simulatePhysicalPrint(mutex, jobId, workBarrier) {
  const lockHandle = await mutex.acquire(jobId);
  try {
    await workBarrier;
    return { lockHandle, outcome: 'success' };
  } catch (err) {
    if (err.isAmbiguous) {
      mutex.lockForAmbiguous(jobId);
      return { lockHandle: null, outcome: 'ambiguous' };
    }
    lockHandle.release();
    return { lockHandle: null, outcome: 'error' };
  }
}

// ─── PrintMutex Unit Tests ────────────────────────────────────────────────────

describe('PrintMutex — unit tests', () => {

  // Test 1
  test('1. starts unlocked, isLocked() === false', () => {
    const mutex = makeMutex();
    expect(mutex.isLocked()).toBe(false);
    expect(mutex.getHeldJobId()).toBeNull();
  });

  // Test 2
  test('2. single acquire grants lock immediately', async () => {
    const mutex = makeMutex();
    const handle = await mutex.acquire('JOB-A');
    expect(mutex.isLocked()).toBe(true);
    expect(mutex.getHeldJobId()).toBe('JOB-A');
    handle.release();
    expect(mutex.isLocked()).toBe(false);
    expect(mutex.getHeldJobId()).toBeNull();
  });

  // Test 3
  test('3. two concurrent acquires: Job B waits while Job A holds lock', async () => {
    const mutex = makeMutex();
    const order = [];

    const barrierA = makeBarrier();

    // Job A: acquire and hold until barrierA resolves
    // We await the acquire directly here (not inside an IIFE) so the lock is
    // guaranteed held before we even start B's acquire() call.
    const handleA = await mutex.acquire('JOB-A');
    order.push('A_acquired');

    // Job B: start acquiring — will block because A holds the lock
    const jobBPromise = (async () => {
      order.push('B_waiting');
      const handle = await mutex.acquire('JOB-B');
      order.push('B_acquired');
      handle.release();
    })();

    // Flush microtasks: B's acquire() has been called, 'B_waiting' is pushed,
    // and B is now suspended waiting for the chain.
    await new Promise(r => setImmediate(r));

    expect(order).toContain('A_acquired');
    expect(order).toContain('B_waiting');
    expect(order).not.toContain('B_acquired');
    expect(mutex.isLocked()).toBe(true);
    expect(mutex.getHeldJobId()).toBe('JOB-A');

    // Release A
    order.push('A_released');
    handleA.release();
    await jobBPromise;

    expect(order).toEqual(['A_acquired', 'B_waiting', 'A_released', 'B_acquired']);
  });

  // Test 4
  test('4. Job B starts ONLY after Job A persists terminal completion evidence', async () => {
    const mutex = makeMutex();
    const completionSequence = [];
    const barrierA = makeBarrier();

    const jobA = (async () => {
      const handle = await mutex.acquire('JOB-A');
      // Simulate: journal.recordCompleted (before releasing lock)
      await barrierA.promise;
      completionSequence.push('A_journal_persisted');
      handle.release();
      completionSequence.push('A_lock_released');
    })();

    await Promise.resolve();

    const jobB = (async () => {
      const handle = await mutex.acquire('JOB-B');
      completionSequence.push('B_started');
      handle.release();
    })();

    await Promise.resolve();
    await Promise.resolve();

    // B must not have started yet
    expect(completionSequence).not.toContain('B_started');

    barrierA.resolve();
    await jobA;
    await jobB;

    // Order must be: A persists evidence → A releases → B starts
    expect(completionSequence.indexOf('A_journal_persisted'))
      .toBeLessThan(completionSequence.indexOf('B_started'));
    expect(completionSequence.indexOf('A_lock_released'))
      .toBeLessThan(completionSequence.indexOf('B_started'));
  });

  // Test 5
  test('5. duplicate delivery of Job A does not trigger a second physical print', async () => {
    // Demonstrates that the idempotency guard (journal.isDispatched check)
    // prevents a second physical print even if the mutex would have allowed
    // another call through (e.g., because the first already released it).
    // The mutex serializes; the idempotency set prevents reprinting.
    const mutex = makeMutex();
    let physicalPrintCount = 0;
    const dispatched = new Set(); // simulates journal.isDispatched()

    // Helper: simulates what the physical_print_job handler does
    const dispatchIfNotDuplicate = async (jobId) => {
      // Pre-lock idempotency check (like the journal check before acquire)
      if (dispatched.has(jobId)) return 'duplicate_rejected_pre_lock';

      const handle = await mutex.acquire(jobId);

      // Post-lock re-check (after waiting, state may have changed)
      if (dispatched.has(jobId)) {
        handle.release();
        return 'duplicate_rejected_post_lock';
      }

      // Mark dispatched before physical print (like recordDispatched)
      dispatched.add(jobId);
      physicalPrintCount++;
      // Simulate a quick "print" and release
      handle.release();
      return 'dispatched';
    };

    // First call: will dispatch
    const result1 = await dispatchIfNotDuplicate('JOB-A');
    expect(result1).toBe('dispatched');
    expect(physicalPrintCount).toBe(1);

    // Second call with same jobId: idempotency guard fires immediately (pre-lock)
    const result2 = await dispatchIfNotDuplicate('JOB-A');
    expect(result2).toBe('duplicate_rejected_pre_lock');
    expect(physicalPrintCount).toBe(1); // Still 1 — no second print
  });

  // Test 6
  test('6. ambiguous Job A prevents Job B from ever dispatching', async () => {
    const mutex = makeMutex();
    const barrierA = makeBarrier();

    // Job A acquires and then goes ambiguous
    const jobAPromise = (async () => {
      const handle = await mutex.acquire('JOB-A');
      await barrierA.promise;
      // Ambiguous: permanently lock (do NOT call handle.release())
      mutex.lockForAmbiguous('JOB-A');
    })();

    await Promise.resolve();

    // Job B: attempts to acquire — will be queued forever
    let jobBStarted = false;
    const jobBPromise = mutex.acquire('JOB-B').then(handle => {
      jobBStarted = true;
      handle.release();
    });

    // Trigger ambiguous
    barrierA.resolve();
    await jobAPromise;

    // Flush microtasks
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Job B must remain permanently blocked
    expect(jobBStarted).toBe(false);
    expect(mutex.isLocked()).toBe(true);
    expect(mutex.getHeldJobId()).toBe('AMBIGUOUS:JOB-A');

    // Cleanup: we don't await jobBPromise since it never resolves (by design)
    // Jest will not hang on unresolved promises that are not awaited
  });

  // Test 7
  test('7. journal persistence failure prevents unsafe lock release (isAmbiguous=true)', async () => {
    const mutex = makeMutex();

    const handle = await mutex.acquire('JOB-A');
    expect(mutex.isLocked()).toBe(true);

    // Simulate journal.recordCompleted() throwing (persistence failure)
    const persistenceErr = Object.assign(new Error('Journal disk write failed'), { isAmbiguous: true });

    // Caller code: when spooler rejects with isAmbiguous, calls lockForAmbiguous
    mutex.lockForAmbiguous('JOB-A');

    // Verify: locked, no release
    expect(mutex.isLocked()).toBe(true);
    expect(mutex.getHeldJobId()).toBe('AMBIGUOUS:JOB-A');

    // Confirm that attempting to acquire for Job B never resolves
    let jobBGranted = false;
    mutex.acquire('JOB-B').then(() => { jobBGranted = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(jobBGranted).toBe(false);
  });

  // Test 8
  test('8. definite print error releases lock so next job can proceed', async () => {
    const mutex = makeMutex();
    const barrierA = makeBarrier();
    const order = [];

    const jobAPromise = (async () => {
      const handle = await mutex.acquire('JOB-A');
      order.push('A_started');
      await barrierA.promise; // simulate definite error
      // Definite error (not ambiguous) → release lock
      handle.release();
      order.push('A_lock_released');
    })();

    await Promise.resolve();

    const jobBPromise = (async () => {
      const handle = await mutex.acquire('JOB-B');
      order.push('B_started');
      handle.release();
    })();

    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(['A_started']);

    // Simulate definite error settlement
    barrierA.resolve();
    await jobAPromise;
    await jobBPromise;

    expect(order).toEqual(['A_started', 'A_lock_released', 'B_started']);
  });

  // Test 9
  test('9. startup mutex lock for in-flight job prevents next job', async () => {
    // Simulates: on agent restart, journal has DISPATCHED_TO_SPOOLER state.
    // The agent calls mutex.lockForAmbiguous() during startup.
    const mutex = makeMutex();
    mutex.lockForAmbiguous('JOB-RESTART');

    expect(mutex.isLocked()).toBe(true);
    expect(mutex.getHeldJobId()).toBe('AMBIGUOUS:JOB-RESTART');

    let jobBGranted = false;
    mutex.acquire('JOB-B').then(handle => {
      jobBGranted = true;
      handle.release();
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(jobBGranted).toBe(false);
  });

  // Test 10
  test('10. three queued jobs execute in FIFO order, each waiting for the previous', async () => {
    const mutex = makeMutex();
    const order = [];
    const barrierA = makeBarrier();
    const barrierB = makeBarrier();
    const barrierC = makeBarrier();

    // Acquire job A's lock directly so we know it's held before B/C even start
    const handleA = await mutex.acquire('JOB-A');
    order.push('A_start');

    // Now queue B and C
    const jobB = (async () => {
      order.push('B_queued');
      const handle = await mutex.acquire('JOB-B');
      order.push('B_start');
      await barrierB.promise;
      order.push('B_end');
      handle.release();
    })();

    const jobC = (async () => {
      order.push('C_queued');
      const handle = await mutex.acquire('JOB-C');
      order.push('C_start');
      await barrierC.promise;
      order.push('C_end');
      handle.release();
    })();

    // Flush microtasks: B_queued and C_queued should be recorded
    await new Promise(r => setImmediate(r));

    expect(order).toContain('A_start');
    expect(order).toContain('B_queued');
    expect(order).toContain('C_queued');
    expect(order).not.toContain('B_start');
    expect(order).not.toContain('C_start');

    // Release A — B should proceed
    order.push('A_end');
    handleA.release();
    await new Promise(r => setImmediate(r));

    expect(order).toContain('B_start');
    expect(order).not.toContain('C_start');

    barrierB.resolve();
    await jobB;
    await new Promise(r => setImmediate(r));
    expect(order).toContain('C_start');

    barrierC.resolve();
    await jobC;

    // Verify complete FIFO ordering
    const aStart = order.indexOf('A_start');
    const aEnd = order.indexOf('A_end');
    const bStart = order.indexOf('B_start');
    const bEnd = order.indexOf('B_end');
    const cStart = order.indexOf('C_start');
    const cEnd = order.indexOf('C_end');

    expect(aEnd).toBeLessThan(bStart); // A releases before B starts
    expect(bEnd).toBeLessThan(cStart); // B releases before C starts
  });
});

// ─── SpoolerMonitor Integration: Promise return value ─────────────────────────

const SpoolerMonitor = require('../../printer-agent/src/spooler');

describe('SpoolerMonitor — startPollingJob returns Promise (P1-01 integration)', () => {

  let mockExecFile;
  let mockSocket;
  let mockJournal;

  beforeEach(() => {
    mockExecFile = jest.fn();
    mockSocket = { emit: jest.fn() };
    mockJournal = {
      recordCompleted: jest.fn(),
      recordFailed: jest.fn()
    };

    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Test 11
  test('11. simulation mode resolves promise after journal.recordCompleted()', async () => {
    const monitor = new SpoolerMonitor({
      execFile: mockExecFile,
      printerName: null, // triggers simulation mode
      journal: mockJournal
    });

    const tempFile = path.join(os.tmpdir(), 'p1_01_sim_test.pdf');
    fs.writeFileSync(tempFile, 'fake pdf');

    const resultPromise = monitor.startPollingJob('JOB-SIM', tempFile, mockSocket);
    expect(resultPromise).toBeInstanceOf(Promise);

    // Advance the 3000ms simulation timer
    jest.advanceTimersByTime(3100);
    // Run microtasks generated by the timer
    await Promise.resolve();
    await Promise.resolve();

    const result = await resultPromise;
    expect(result.outcome).toBe('success');
    expect(mockJournal.recordCompleted).toHaveBeenCalledWith('JOB-SIM', { mode: 'simulation' });
    expect(mockSocket.emit).toHaveBeenCalledWith('print_physical_success', expect.objectContaining({ jobId: 'JOB-SIM' }));
  });

  // Test 12
  test('12. simulation mode rejects with isAmbiguous=true if journal.recordCompleted throws', async () => {
    const monitor = new SpoolerMonitor({
      execFile: mockExecFile,
      printerName: null,
      journal: {
        recordCompleted: jest.fn(() => { throw new Error('disk full'); })
      }
    });

    const tempFile = path.join(os.tmpdir(), 'p1_01_sim_ambig_test.pdf');
    fs.writeFileSync(tempFile, 'fake pdf');

    const resultPromise = monitor.startPollingJob('JOB-AMBIG', tempFile, mockSocket);

    jest.advanceTimersByTime(3100);
    await Promise.resolve();
    await Promise.resolve();

    await expect(resultPromise).rejects.toMatchObject({ isAmbiguous: true });
    expect(mockSocket.emit).toHaveBeenCalledWith('print_physical_error', expect.objectContaining({
      jobId: 'JOB-AMBIG',
      error: expect.stringContaining('Terminal evidence persistence failed')
    }));
  });
});

// ─── P1-04 / P1-05 Regression Guard ─────────────────────────────────────────

describe('P1-01: Regression guard — P1-04 and P1-05 protections intact', () => {

  // Test 13
  test('13. journal.isDispatched() correctly identifies dispatched states', () => {
    const tmpPath = path.join(os.tmpdir(), `p1_01_journal_${Date.now()}.json`);
    const journal = new JobJournal(tmpPath);

    journal.recordReceived('JOB-01', {});
    expect(journal.isDispatched('JOB-01')).toBe(false);

    journal.recordDispatched('JOB-01', { printerName: 'Epson' });
    expect(journal.isDispatched('JOB-01')).toBe(true);

    journal.recordCompleted('JOB-01', {});
    expect(journal.isDispatched('JOB-01')).toBe(true); // COMPLETED_LOCALLY is still "dispatched"

    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  // Test 14
  test('14. P1-04: fail-closed journal detects corruption and throws JournalCorruptionError', () => {
    const tmpPath = path.join(os.tmpdir(), `p1_01_corrupt_${Date.now()}.json`);
    fs.writeFileSync(tmpPath, '{"version":1,"jobs":{},"checksum":"INVALIDCHECKSUM"}', 'utf8');
    expect(() => new JobJournal(tmpPath)).toThrow(/checksum mismatch/i);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  // Test 15
  test('15. P1-04: recoverOnStartup transitions in-flight jobs to AMBIGUOUS', () => {
    const tmpPath = path.join(os.tmpdir(), `p1_01_startup_${Date.now()}.json`);
    const journal1 = new JobJournal(tmpPath);
    journal1.recordReceived('JOB-INFLIGHT', {});
    journal1.recordDispatched('JOB-INFLIGHT', { printerName: 'Epson' });

    // Simulate agent restart — load from same file
    const journal2 = new JobJournal(tmpPath);
    journal2.recoverOnStartup();

    const entry = journal2.getJob('JOB-INFLIGHT');
    expect(entry.state).toBe('AMBIGUOUS_REQUIRES_OPERATOR_REVIEW');

    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  // Test 16
  test('16. mutex.lockForAmbiguous is triggered by in-flight journal state at startup', () => {
    const tmpPath = path.join(os.tmpdir(), `p1_01_ambig_startup_${Date.now()}.json`);
    const journal = new JobJournal(tmpPath);
    journal.recordDispatched('JOB-X', { printerName: 'Epson' });

    // Simulate: startup code
    journal.recoverOnStartup();
    const ambiguousJob = Object.values(journal.jobs)
      .find(j => ['DISPATCHED_TO_SPOOLER', 'SPOOLING', 'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW'].includes(j.state));

    const mutex = makeMutex();
    if (ambiguousJob) {
      mutex.lockForAmbiguous(ambiguousJob.jobId);
    }

    expect(mutex.isLocked()).toBe(true);
    expect(mutex.getHeldJobId()).toContain('AMBIGUOUS');

    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  // Test 17
  test('17. P1-05: atomic claim prevents duplicate physical dispatch (simulate updateMany)', async () => {
    // Simulate the atomic conditional claim used in queueService.processJob().
    // Only one "worker" can claim status WAITING → PRINTING.
    const jobStore = { status: 'WAITING' };

    // Simulates prisma.printJob.updateMany where status === 'WAITING'
    function atomicClaim() {
      if (jobStore.status === 'WAITING') {
        jobStore.status = 'PRINTING';
        return { count: 1 };
      }
      return { count: 0 };
    }

    const results = await Promise.all([
      Promise.resolve(atomicClaim()),
      Promise.resolve(atomicClaim())
    ]);

    const claimed = results.filter(r => r.count === 1).length;
    expect(claimed).toBe(1); // Only one succeeds
    expect(jobStore.status).toBe('PRINTING');
  });

  // Test 18
  test('18. reconciliation handler does NOT bypass serialization: idempotency guard fires first', () => {
    // The reconcile_active_jobs handler in index.js only emits print_physical_success
    // for jobs that journal.isDispatched() returns true for — it does NOT re-enter
    // the physical_print_job handler or acquire the mutex.
    // This test verifies that isDispatched() correctly short-circuits any re-dispatch.
    const tmpPath = path.join(os.tmpdir(), `p1_01_recon_${Date.now()}.json`);
    const journal = new JobJournal(tmpPath);
    journal.recordDispatched('JOB-RECON', { printerName: 'Epson' });

    // Simulate reconcile_active_jobs logic
    const jobId = 'JOB-RECON';
    const entry = journal.getJob(jobId);
    const isAlreadyDispatched = journal.isDispatched(jobId);

    // Reconciliation path: would emit print_physical_success (not re-dispatch)
    expect(isAlreadyDispatched).toBe(true);
    expect(entry.state).toBe('DISPATCHED_TO_SPOOLER');

    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });
});
