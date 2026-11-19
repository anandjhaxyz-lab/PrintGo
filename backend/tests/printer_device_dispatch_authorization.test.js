const {
  DISPATCH_LEASE_TTL_MS,
  authorizePrinterDeviceDispatch,
  renewPrinterDeviceDispatchLease,
  releasePrinterDeviceDispatchLease
} = require('../src/services/printerDeviceJobBinding.service');

const request = {
  requestId: 'req-authorization-001',
  jobId: 'JOB_DEVICE_001',
  printerDeviceId: 'device-epson',
  windowsPrinterName: 'Epson L6460'
};

const makeJob = (overrides = {}) => ({
  shortId: request.jobId,
  machineId: 'machine-a',
  status: 'PRINTING',
  printerDeviceId: request.printerDeviceId,
  printerWindowsQueueName: request.windowsPrinterName,
  printerDevice: {
    id: request.printerDeviceId,
    machineId: 'machine-a',
    windowsPrinterName: request.windowsPrinterName,
    status: 'ACTIVE',
    approvedAt: new Date('2026-11-19T00:00:00.000Z')
  },
  ...overrides
});

function makeSocket(overrides = {}) {
  return {
    userType: 'printer',
    machineId: 'machine-a',
    emit: jest.fn(),
    ...overrides
  };
}

function makeDatabase({ job = makeJob(), lease = null } = {}) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: request.printerDeviceId }]),
    printJob: {
      findUnique: jest.fn().mockResolvedValue(job)
    },
    printerDeviceDispatchLease: {
      findUnique: jest.fn().mockResolvedValue(lease),
      upsert: jest.fn().mockImplementation(async ({ create, update }) => ({ ...create, ...update })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    }
  };
  const prisma = {
    $transaction: jest.fn(async (callback) => callback(tx))
  };
  return { prisma, tx };
}

describe('Last-moment PrinterDevice dispatch authorization and lease lifecycle', () => {
  beforeEach(() => {
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'true';
  });

  afterAll(() => {
    delete process.env.ENABLE_MULTI_PRINTER_DISPATCH;
  });

  test('locks the device row, checks current DB identity and creates a bounded lease before approval', async () => {
    const socket = makeSocket();
    const { prisma, tx } = makeDatabase();

    const result = await authorizePrinterDeviceDispatch({ socket, prisma, request });

    expect(result).toEqual({ accepted: true, requestId: request.requestId });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.printJob.findUnique).toHaveBeenCalledWith({
      where: { shortId: request.jobId },
      include: { printerDevice: true }
    });
    expect(tx.printerDeviceDispatchLease.upsert).toHaveBeenCalledWith({
      where: { printerDeviceId: request.printerDeviceId },
      create: expect.objectContaining({
        printerDeviceId: request.printerDeviceId,
        requestId: request.requestId,
        jobShortId: request.jobId,
        expiresAt: expect.any(Date),
        releasedAt: null
      }),
      update: expect.objectContaining({
        requestId: request.requestId,
        jobShortId: request.jobId,
        expiresAt: expect.any(Date),
        releasedAt: null
      })
    });
    const leaseExpiry = tx.printerDeviceDispatchLease.upsert.mock.calls[0][0].create.expiresAt;
    expect(leaseExpiry.getTime()).toBeGreaterThan(Date.now());
    expect(leaseExpiry.getTime()).toBeLessThanOrEqual(Date.now() + DISPATCH_LEASE_TTL_MS + 100);
    expect(socket.emit).toHaveBeenCalledWith('printer_device_dispatch_authorization_result', expect.objectContaining({
      requestId: request.requestId,
      allowed: true,
      jobId: request.jobId,
      printerDeviceId: request.printerDeviceId,
      windowsPrinterName: request.windowsPrinterName,
      machineId: 'machine-a',
      leaseExpiresAt: expect.any(Date)
    }));
  });

  test('denies a disabled or remapped device at the final authorization boundary', async () => {
    const socket = makeSocket();
    const disabledDb = makeDatabase({
      job: makeJob({ printerDevice: { ...makeJob().printerDevice, status: 'DISABLED' } })
    });
    const disabled = await authorizePrinterDeviceDispatch({ socket, prisma: disabledDb.prisma, request });
    expect(disabled.code).toBe('DEVICE_NOT_ACTIVE');
    expect(disabledDb.tx.printerDeviceDispatchLease.upsert).not.toHaveBeenCalled();

    const remappedDb = makeDatabase({
      job: makeJob({ printerDevice: { ...makeJob().printerDevice, windowsPrinterName: 'Epson L6460 (Copy 1)' } })
    });
    const remapped = await authorizePrinterDeviceDispatch({ socket, prisma: remappedDb.prisma, request });
    expect(remapped.code).toBe('QUEUE_MAPPING_MISMATCH');
    expect(remappedDb.tx.printerDeviceDispatchLease.upsert).not.toHaveBeenCalled();
  });

  test('denies a second in-flight dispatch lease for the same physical printer', async () => {
    const activeLease = {
      printerDeviceId: request.printerDeviceId,
      requestId: 'other-request',
      jobShortId: 'OTHER_JOB',
      expiresAt: new Date(Date.now() + 30000),
      releasedAt: null
    };
    const socket = makeSocket();
    const { prisma, tx } = makeDatabase({ lease: activeLease });

    const result = await authorizePrinterDeviceDispatch({ socket, prisma, request });

    expect(result.code).toBe('DEVICE_DISPATCH_IN_PROGRESS');
    expect(tx.printerDeviceDispatchLease.upsert).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('printer_device_dispatch_authorization_result', expect.objectContaining({
      allowed: false,
      code: 'DEVICE_DISPATCH_IN_PROGRESS'
    }));
  });

  test('allows the same correlated authorization request to be retried idempotently', async () => {
    const activeLease = {
      printerDeviceId: request.printerDeviceId,
      requestId: request.requestId,
      jobShortId: request.jobId,
      expiresAt: new Date(Date.now() + 30000),
      releasedAt: null
    };
    const { prisma, tx } = makeDatabase({ lease: activeLease });
    const result = await authorizePrinterDeviceDispatch({ socket: makeSocket(), prisma, request });

    expect(result.accepted).toBe(true);
    expect(tx.printerDeviceDispatchLease.upsert).toHaveBeenCalledTimes(1);
  });

  test('denies when the job is no longer PRINTING, belongs to another Machine, or has no approval', async () => {
    const waitingDb = makeDatabase({ job: makeJob({ status: 'WAITING' }) });
    expect((await authorizePrinterDeviceDispatch({ socket: makeSocket(), prisma: waitingDb.prisma, request })).code)
      .toBe('JOB_NOT_DISPATCHABLE');

    const wrongMachineDb = makeDatabase({ job: makeJob({ machineId: 'machine-b' }) });
    expect((await authorizePrinterDeviceDispatch({ socket: makeSocket(), prisma: wrongMachineDb.prisma, request })).code)
      .toBe('MACHINE_BINDING_MISMATCH');

    const unapprovedDb = makeDatabase({
      job: makeJob({ printerDevice: { ...makeJob().printerDevice, approvedAt: null } })
    });
    expect((await authorizePrinterDeviceDispatch({ socket: makeSocket(), prisma: unapprovedDb.prisma, request })).code)
      .toBe('DEVICE_NOT_APPROVED');
  });

  test('denies when feature gate is disabled or Agent is unauthorized', async () => {
    const { prisma, tx } = makeDatabase();
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'false';
    const disabled = await authorizePrinterDeviceDispatch({ socket: makeSocket(), prisma, request });
    expect(disabled.code).toBe('DISPATCH_FEATURE_DISABLED');
    expect(tx.$queryRaw).not.toHaveBeenCalled();

    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'true';
    const unauthorized = await authorizePrinterDeviceDispatch({
      socket: makeSocket({ userType: 'admin' }), prisma, request
    });
    expect(unauthorized.code).toBe('UNAUTHORIZED_AGENT');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  test('fails closed for malformed identity and database failure', async () => {
    const { prisma, tx } = makeDatabase();
    const malformed = await authorizePrinterDeviceDispatch({
      socket: makeSocket(), prisma, request: { ...request, jobId: '../invalid' }
    });
    expect(malformed.code).toBe('INVALID_DISPATCH_REQUEST');
    expect(tx.$queryRaw).not.toHaveBeenCalled();

    const failingPrisma = {
      $transaction: jest.fn().mockRejectedValue(new Error('database unavailable'))
    };
    const failed = await authorizePrinterDeviceDispatch({
      socket: makeSocket(), prisma: failingPrisma, request
    });
    expect(failed.code).toBe('AUTHORIZATION_UNAVAILABLE');
  });

  test('renews only the matching active lease on the authenticated Machine', async () => {
    const lease = {
      printerDeviceId: request.printerDeviceId,
      requestId: request.requestId,
      jobShortId: request.jobId,
      expiresAt: new Date(Date.now() + 30000),
      releasedAt: null,
      printerDevice: { machineId: 'machine-a' }
    };
    const { prisma, tx } = makeDatabase({ lease });
    const result = await renewPrinterDeviceDispatchLease({ socket: makeSocket(), prisma, request });

    expect(result.renewed).toBe(true);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.printerDeviceDispatchLease.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        printerDeviceId: request.printerDeviceId,
        requestId: request.requestId,
        jobShortId: request.jobId,
        releasedAt: null,
        expiresAt: { gt: expect.any(Date) }
      }),
      data: { expiresAt: expect.any(Date) }
    }));
  });

  test('does not renew an expired, released, or foreign-Machine lease', async () => {
    const expired = {
      printerDeviceId: request.printerDeviceId,
      requestId: request.requestId,
      jobShortId: request.jobId,
      expiresAt: new Date(Date.now() - 1000),
      releasedAt: null,
      printerDevice: { machineId: 'machine-a' }
    };
    const expiredDb = makeDatabase({ lease: expired });
    expect((await renewPrinterDeviceDispatchLease({
      socket: makeSocket(), prisma: expiredDb.prisma, request
    })).renewed).toBe(false);
    expect(expiredDb.tx.printerDeviceDispatchLease.updateMany).not.toHaveBeenCalled();

    const foreignDb = makeDatabase({
      lease: { ...expired, expiresAt: new Date(Date.now() + 10000), printerDevice: { machineId: 'machine-b' } }
    });
    expect((await renewPrinterDeviceDispatchLease({
      socket: makeSocket(), prisma: foreignDb.prisma, request
    })).renewed).toBe(false);
    expect(foreignDb.tx.printerDeviceDispatchLease.updateMany).not.toHaveBeenCalled();
  });

  test('releases only the matching lease and rejects a replay from a different request', async () => {
    const lease = {
      printerDeviceId: request.printerDeviceId,
      requestId: request.requestId,
      jobShortId: request.jobId,
      expiresAt: new Date(Date.now() + 30000),
      releasedAt: null,
      printerDevice: { machineId: 'machine-a' }
    };
    const db = makeDatabase({ lease });
    const released = await releasePrinterDeviceDispatchLease({
      socket: makeSocket(), prisma: db.prisma, request
    });
    expect(released.released).toBe(true);

    const replayDb = makeDatabase({ lease: { ...lease, requestId: 'other-request' } });
    const replay = await releasePrinterDeviceDispatchLease({
      socket: makeSocket(), prisma: replayDb.prisma, request
    });
    expect(replay.released).toBe(false);
    expect(replay.code).toBe('DISPATCH_LEASE_NOT_ACTIVE');
    expect(replayDb.tx.printerDeviceDispatchLease.updateMany).not.toHaveBeenCalled();
  });
});
