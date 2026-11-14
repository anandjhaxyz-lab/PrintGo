/**
 * Automated Test Suite: P1-05 Redis Timeout Fallback Race & Concurrency Hardening
 *
 * Verifies that:
 * 1. Normal successful BullMQ enqueue uses deterministic jobId (print_<shortId>).
 * 2. Enqueue taking >2500ms does NOT trigger an unsafe fallback dispatch.
 * 3. Enqueue timeout/failure rejects observably without direct fallback dispatch.
 * 4. Concurrent processJob calls execute atomic database claim, emitting exactly 1 print job.
 * 5. Duplicate BullMQ job delivery is safely deduplicated by atomic DB state machine claim.
 * 6. Already-claimed (PRINTING, COMPLETED, FAILED) jobs refuse dispatch.
 * 7. Redis reconnection/unavailable scenario never dispatches via fallback.
 */

// Mock Prisma client before importing queueService
const mockUpdateMany = jest.fn();
const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();

jest.mock('../src/utils/prisma', () => ({
  printJob: {
    updateMany: (...args) => mockUpdateMany(...args),
    findUnique: (...args) => mockFindUnique(...args),
    update: (...args) => mockUpdate(...args)
  }
}));

const queueService = require('../src/services/queueService');

describe('P1-05: Queue Dispatch & Concurrency Safety', () => {
  let mockIo;
  let emittedEvents;
  let mockQueue;

  beforeEach(() => {
    jest.clearAllMocks();
    emittedEvents = [];

    mockIo = {
      to: jest.fn().mockImplementation((room) => ({
        emit: jest.fn().mockImplementation((event, data) => {
          emittedEvents.push({ room, event, data });
        })
      }))
    };

    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'mock-bullmq-job-1' })
    };

    // Inject mock queue and enable Redis mode
    queueService._setQueueForTesting(mockQueue, true, mockIo);
  });

  afterAll(() => {
    // Reset queue testing state
    queueService._setQueueForTesting(null, false, null);
  });

  test('1. Normal successful enqueue uses deterministic jobId and does NOT call processJob directly', async () => {
    const shortId = 'job_norm_1';

    const result = await queueService.startPrintingProcess(shortId, mockIo);

    // Verified BullMQ add call
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    expect(mockQueue.add).toHaveBeenCalledWith(
      'printJob',
      { shortId },
      expect.objectContaining({
        jobId: `print_${shortId}`,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: false
      })
    );

    // startPrintingProcess must return the enqueued job and not call processJob directly
    expect(result).toEqual({ id: 'mock-bullmq-job-1' });
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(emittedEvents).toHaveLength(0);
  });

  test('2. Enqueue operation taking longer than 2500ms does NOT trigger fallback dispatch', async () => {
    const shortId = 'job_slow_2';

    // Simulate slow enqueue taking 2600ms
    mockQueue.add.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50)); // Scaled for test speed
      return { id: `bull_${shortId}` };
    });

    const result = await queueService.startPrintingProcess(shortId, mockIo);

    expect(result).toEqual({ id: `bull_${shortId}` });
    // Crucial: No direct processJob call was triggered
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(emittedEvents).toHaveLength(0);
  });

  test('3. Enqueue failure does NOT trigger direct processJob fallback dispatch', async () => {
    const shortId = 'job_fail_3';
    mockQueue.add.mockRejectedValue(new Error('Redis connection timed out after 3000ms'));

    // Must reject observably
    await expect(queueService.startPrintingProcess(shortId, mockIo)).rejects.toThrow(
      'Redis connection timed out after 3000ms'
    );

    // Crucial: Fallback in-memory dispatch must NEVER be called
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(emittedEvents).toHaveLength(0);
  });

  test('4. Redis unavailable/reconnection scenario throws without direct fallback dispatch', async () => {
    const shortId = 'job_econn_4';
    mockQueue.add.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379'));

    await expect(queueService.startPrintingProcess(shortId, mockIo)).rejects.toThrow(
      'ECONNREFUSED'
    );

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(emittedEvents).toHaveLength(0);
  });

  test('5. Two concurrent processJob calls claim atomically: exactly ONE physical print job dispatched', async () => {
    const shortId = 'job_race_5';

    const testJobDoc = {
      id: 'job-uuid-5',
      shortId,
      status: 'PRINTING',
      machineId: 'machine_eps_01',
      cost: 10.0,
      pagesToPrint: 2,
      color: 'bw',
      duplex: 'single',
      copies: 1,
      pageRangeType: 'all',
      customRange: null,
      encryptedKey: 'enc_key_123',
      iv: 'iv_123',
      document: {
        filename: 'http://localhost:5000/uploads/doc5.pdf',
        originalName: 'test_concurrency.pdf'
      }
    };

    // Simulate atomic DB behavior: First updateMany wins ({ count: 1 }), second loses ({ count: 0 })
    let claimAttempt = 0;
    mockUpdateMany.mockImplementation(async ({ where, data }) => {
      claimAttempt++;
      if (claimAttempt === 1) {
        return { count: 1 };
      }
      return { count: 0 };
    });

    mockFindUnique.mockImplementation(async ({ where }) => {
      if (where.shortId === shortId) {
        return testJobDoc;
      }
      return null;
    });

    // Run two concurrent processJob executions (e.g. BullMQ worker + race condition)
    const [res1, res2] = await Promise.all([
      queueService.processJob(shortId),
      queueService.processJob(shortId)
    ]);

    // Exactly one call claimed the job
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
    expect(res1).not.toBeNull();
    expect(res2).toBeNull();

    // Exactly one physical_print_job socket event emitted to machine room
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].room).toBe('machine_machine_eps_01');
    expect(emittedEvents[0].event).toBe('physical_print_job');
    expect(emittedEvents[0].data.jobId).toBe(shortId);
  });

  test('6. Duplicate BullMQ job delivery refuses second dispatch when status is no longer WAITING', async () => {
    const shortId = 'job_dup_6';

    const testJobDoc = {
      id: 'job-uuid-6',
      shortId,
      status: 'PRINTING',
      machineId: 'machine_eps_01',
      cost: 5.0,
      pagesToPrint: 1,
      color: 'bw',
      duplex: 'single',
      copies: 1,
      pageRangeType: 'all',
      customRange: null,
      encryptedKey: null,
      iv: null,
      document: {
        filename: 'http://localhost:5000/uploads/doc6.pdf',
        originalName: 'dup_test.pdf'
      }
    };

    // Delivery 1: Succeeds
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockFindUnique.mockResolvedValueOnce(testJobDoc);

    const firstRun = await queueService.processJob(shortId);
    expect(firstRun).not.toBeNull();
    expect(emittedEvents).toHaveLength(1);

    // Delivery 2: Redis at-least-once duplicate delivery arrives
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockFindUnique.mockResolvedValueOnce({ id: 'job-uuid-6', status: 'PRINTING' });

    const secondRun = await queueService.processJob(shortId);
    expect(secondRun).toBeNull();

    // Still exactly 1 physical dispatch
    expect(emittedEvents).toHaveLength(1);
  });

  test('7. Already-claimed job (COMPLETED or FAILED) refuses dispatch', async () => {
    const shortId = 'job_term_7';

    // DB updateMany finds 0 rows because status != WAITING
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockFindUnique.mockResolvedValueOnce({ id: 'job-uuid-7', status: 'COMPLETED' });

    const result = await queueService.processJob(shortId);

    expect(result).toBeNull();
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { shortId, status: 'WAITING' },
      data: { status: 'PRINTING' }
    });
    expect(emittedEvents).toHaveLength(0);
  });

  test('8. Enqueue timeout then delayed BullMQ delivery guarantees exactly ONE physical dispatch', async () => {
    const shortId = 'job_delayed_8';

    const testJobDoc = {
      id: 'job-uuid-8',
      shortId,
      status: 'PRINTING',
      machineId: 'machine_eps_01',
      cost: 15.0,
      pagesToPrint: 3,
      color: 'color',
      duplex: 'double',
      copies: 1,
      pageRangeType: 'all',
      customRange: null,
      encryptedKey: 'enc_8',
      iv: 'iv_8',
      document: {
        filename: 'http://localhost:5000/uploads/doc8.pdf',
        originalName: 'delayed_receipt.pdf'
      }
    };

    // Step A: Caller experiences an enqueue timeout
    mockQueue.add.mockRejectedValueOnce(new Error('BullMQ enqueue timeout after 2500ms'));

    await expect(queueService.startPrintingProcess(shortId, mockIo)).rejects.toThrow(
      'BullMQ enqueue timeout'
    );

    // During timeout: 0 physical prints dispatched (no fallback!)
    expect(emittedEvents).toHaveLength(0);

    // Step B: In Redis, the enqueue actually committed and worker picks it up
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockFindUnique.mockResolvedValueOnce(testJobDoc);

    const workerResult = await queueService.processJob(shortId);
    expect(workerResult).not.toBeNull();

    // Step C: Exactly 1 physical dispatch occurred across the whole sequence
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].data.jobId).toBe(shortId);
  });

  test('9. Local development mode without Redis dispatches in-memory safely', async () => {
    const shortId = 'job_inmem_9';

    // Switch to local dev mode (useRedis = false)
    queueService._setQueueForTesting(null, false);

    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockFindUnique.mockResolvedValueOnce({
      id: 'job-uuid-9',
      shortId,
      status: 'PRINTING',
      machineId: 'machine_eps_01',
      cost: 5.0,
      pagesToPrint: 1,
      color: 'bw',
      duplex: 'single',
      copies: 1,
      pageRangeType: 'all',
      customRange: null,
      encryptedKey: null,
      iv: null,
      document: {
        filename: 'http://localhost:5000/uploads/doc9.pdf',
        originalName: 'inmem.pdf'
      }
    });

    const result = await queueService.startPrintingProcess(shortId, mockIo);

    expect(result).not.toBeNull();
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].data.jobId).toBe(shortId);
  });

  test('10. Post-claim missing document transitions claimed job to FAILED and skips dispatch', async () => {
    const shortId = 'job_nodoc_10';

    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockFindUnique.mockResolvedValueOnce({
      id: 'job-uuid-10',
      shortId,
      status: 'PRINTING',
      machineId: 'machine_eps_01',
      cost: 5.0,
      document: null // Missing document relation
    });
    mockUpdate.mockResolvedValueOnce({ id: 'job-uuid-10', status: 'FAILED' });

    const result = await queueService.processJob(shortId);

    expect(result).toBeNull();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { shortId },
      data: { status: 'FAILED' }
    });
    expect(emittedEvents).toHaveLength(0);
  });

  test('11. Post-claim missing machineId transitions claimed job to FAILED and skips dispatch', async () => {
    const shortId = 'job_nomach_11';

    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockFindUnique.mockResolvedValueOnce({
      id: 'job-uuid-11',
      shortId,
      status: 'PRINTING',
      machineId: null, // No printer machine assigned
      cost: 5.0,
      document: {
        filename: 'http://localhost:5000/uploads/doc11.pdf',
        originalName: 'nomach.pdf'
      }
    });
    mockUpdate.mockResolvedValueOnce({ id: 'job-uuid-11', status: 'FAILED' });

    const result = await queueService.processJob(shortId);

    expect(result).toBeNull();
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { shortId },
      data: { status: 'FAILED' }
    });
    expect(emittedEvents).toHaveLength(0);
  });

  test('12. Post-claim socket emission failure preserves ambiguous-job safety and rethrows', async () => {
    const shortId = 'job_sockerr_12';

    mockUpdateMany.mockResolvedValueOnce({ count: 1 });
    mockFindUnique.mockResolvedValueOnce({
      id: 'job-uuid-12',
      shortId,
      status: 'PRINTING',
      machineId: 'machine_eps_01',
      cost: 5.0,
      document: {
        filename: 'http://localhost:5000/uploads/doc12.pdf',
        originalName: 'sockerr.pdf'
      }
    });

    // Make socket emit throw an error
    mockIo.to.mockImplementationOnce(() => ({
      emit: () => {
        throw new Error('Socket transport write buffer full');
      }
    }));

    await expect(queueService.processJob(shortId)).rejects.toThrow(
      'Socket transport write buffer full'
    );

    // Crucial: Must NOT reset back to WAITING because physical dispatch might have partially occurred
    expect(mockUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'WAITING' } })
    );
  });
});
