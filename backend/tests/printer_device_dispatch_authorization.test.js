const { authorizePrinterDeviceDispatch } = require('../src/services/printerDeviceJobBinding.service');

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

describe('Last-moment PrinterDevice dispatch authorization', () => {
  beforeEach(() => {
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'true';
  });

  afterAll(() => {
    delete process.env.ENABLE_MULTI_PRINTER_DISPATCH;
  });

  test('authorizes only the exact active approved device bound to a PRINTING job', async () => {
    const job = makeJob();
    const socket = makeSocket();
    const prisma = { printJob: { findUnique: jest.fn().mockResolvedValue(job) } };

    const result = await authorizePrinterDeviceDispatch({ socket, prisma, request });

    expect(result).toEqual({ accepted: true, requestId: request.requestId });
    expect(prisma.printJob.findUnique).toHaveBeenCalledWith({
      where: { shortId: request.jobId },
      include: { printerDevice: true }
    });
    expect(socket.emit).toHaveBeenCalledWith('printer_device_dispatch_authorization_result', {
      requestId: request.requestId,
      allowed: true,
      jobId: request.jobId,
      printerDeviceId: request.printerDeviceId,
      windowsPrinterName: request.windowsPrinterName,
      machineId: 'machine-a'
    });
  });

  test('denies a job whose device was disabled during document preparation', async () => {
    const job = makeJob({
      printerDevice: { ...makeJob().printerDevice, status: 'DISABLED' }
    });
    const socket = makeSocket();
    const prisma = { printJob: { findUnique: jest.fn().mockResolvedValue(job) } };

    const result = await authorizePrinterDeviceDispatch({ socket, prisma, request });

    expect(result).toEqual({ accepted: false, requestId: request.requestId, code: 'DEVICE_NOT_ACTIVE' });
    expect(socket.emit).toHaveBeenCalledWith('printer_device_dispatch_authorization_result', expect.objectContaining({
      requestId: request.requestId,
      allowed: false,
      code: 'DEVICE_NOT_ACTIVE'
    }));
  });

  test('denies a changed Windows queue mapping before driver submission', async () => {
    const job = makeJob({
      printerDevice: { ...makeJob().printerDevice, windowsPrinterName: 'Epson L6460 (Copy 1)' }
    });
    const socket = makeSocket();
    const prisma = { printJob: { findUnique: jest.fn().mockResolvedValue(job) } };

    const result = await authorizePrinterDeviceDispatch({ socket, prisma, request });

    expect(result.code).toBe('QUEUE_MAPPING_MISMATCH');
    expect(socket.emit).toHaveBeenCalledWith('printer_device_dispatch_authorization_result', expect.objectContaining({
      allowed: false,
      code: 'QUEUE_MAPPING_MISMATCH'
    }));
  });

  test('denies when the job is no longer PRINTING or belongs to another Machine', async () => {
    const socket = makeSocket();
    const waitingPrisma = { printJob: { findUnique: jest.fn().mockResolvedValue(makeJob({ status: 'WAITING' })) } };
    const waiting = await authorizePrinterDeviceDispatch({ socket, prisma: waitingPrisma, request });
    expect(waiting.code).toBe('JOB_NOT_DISPATCHABLE');

    const wrongMachinePrisma = { printJob: { findUnique: jest.fn().mockResolvedValue(makeJob({ machineId: 'machine-b' })) } };
    const wrongMachine = await authorizePrinterDeviceDispatch({ socket, prisma: wrongMachinePrisma, request });
    expect(wrongMachine.code).toBe('MACHINE_BINDING_MISMATCH');
  });

  test('denies when approval evidence or feature gate is missing', async () => {
    const socket = makeSocket();
    const unapproved = makeJob({
      printerDevice: { ...makeJob().printerDevice, approvedAt: null }
    });
    const prisma = { printJob: { findUnique: jest.fn().mockResolvedValue(unapproved) } };
    const result = await authorizePrinterDeviceDispatch({ socket, prisma, request });
    expect(result.code).toBe('DEVICE_NOT_APPROVED');

    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'false';
    const gateResult = await authorizePrinterDeviceDispatch({ socket, prisma, request });
    expect(gateResult.code).toBe('DISPATCH_FEATURE_DISABLED');
  });

  test('rejects unauthenticated Agents and malformed request identities', async () => {
    const prisma = { printJob: { findUnique: jest.fn().mockResolvedValue(makeJob()) } };
    const unauthenticated = makeSocket({ userType: 'admin' });
    const unauthorized = await authorizePrinterDeviceDispatch({ socket: unauthenticated, prisma, request });
    expect(unauthorized.code).toBe('UNAUTHORIZED_AGENT');
    expect(prisma.printJob.findUnique).not.toHaveBeenCalled();

    const malformed = await authorizePrinterDeviceDispatch({
      socket: makeSocket(),
      prisma,
      request: { ...request, jobId: '../invalid' }
    });
    expect(malformed.code).toBe('INVALID_DISPATCH_REQUEST');
    expect(prisma.printJob.findUnique).not.toHaveBeenCalled();
  });

  test('fails closed when the authorization database read fails', async () => {
    const socket = makeSocket();
    const prisma = { printJob: { findUnique: jest.fn().mockRejectedValue(new Error('database unavailable')) } };

    const result = await authorizePrinterDeviceDispatch({ socket, prisma, request });

    expect(result.code).toBe('AUTHORIZATION_UNAVAILABLE');
    expect(socket.emit).toHaveBeenCalledWith('printer_device_dispatch_authorization_result', expect.objectContaining({
      requestId: request.requestId,
      allowed: false,
      code: 'AUTHORIZATION_UNAVAILABLE'
    }));
  });
});
