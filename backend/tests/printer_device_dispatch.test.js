process.env.NODE_ENV = 'test';
process.env.QUEUE_REDIS_REQUIRED = 'false';

jest.mock('../src/utils/prisma', () => ({
  printJob: {
    findUnique: jest.fn(),
    updateMany: jest.fn()
  }
}));

jest.mock('../src/services/redisClient', () => ({ connection: null }));
jest.mock('../src/utils/stateMachine', () => ({
  isValidJobTransition: jest.fn(() => true)
}));

const prisma = require('../src/utils/prisma');
const queueService = require('../src/services/queueService');

const makeDeviceJob = (overrides = {}) => ({
  id: 'db-job-1',
  shortId: 'JOB_DEVICE_001',
  machineId: 'machine-a',
  printerDeviceId: 'device-epson',
  status: 'WAITING',
  pagesToPrint: 2,
  color: 'color',
  duplex: 'single',
  copies: 1,
  pageRangeType: 'all',
  customRange: null,
  cost: 20,
  encryptedKey: 'encrypted-key',
  iv: 'iv-data',
  document: {
    filename: 'https://storage.example.test/job.pdf',
    originalName: 'document.pdf'
  },
  printerDevice: {
    id: 'device-epson',
    machineId: 'machine-a',
    windowsPrinterName: 'Epson L6460',
    status: 'ACTIVE',
    approvedAt: new Date('2026-11-19T00:00:00.000Z')
  },
  ...overrides
});

const createIo = () => {
  const room = { emit: jest.fn() };
  return {
    io: { to: jest.fn(() => room) },
    room
  };
};

describe('Backend device-bound PrintJob dispatch gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'true';
    prisma.printJob.updateMany.mockResolvedValue({ count: 1 });
  });

  afterAll(() => {
    delete process.env.ENABLE_MULTI_PRINTER_DISPATCH;
  });

  test('emits a device-bound job using only the approved database PrinterDevice mapping', async () => {
    const job = makeDeviceJob();
    prisma.printJob.findUnique
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce(job);
    const { io, room } = createIo();

    await queueService.startPrintingProcess(job.shortId, io);

    expect(prisma.printJob.updateMany).toHaveBeenCalledWith({
      where: {
        shortId: job.shortId,
        status: 'WAITING',
        printerDeviceId: 'device-epson'
      },
      data: { status: 'PRINTING' }
    });
    expect(io.to).toHaveBeenCalledWith('machine_machine-a');
    expect(room.emit).toHaveBeenCalledWith('physical_print_job', expect.objectContaining({
      jobId: job.shortId,
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    }));
  });

  test('does not claim or dispatch a device-bound job while the feature gate is disabled', async () => {
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'false';
    const job = makeDeviceJob();
    prisma.printJob.findUnique.mockResolvedValueOnce(job);
    const { io, room } = createIo();

    await queueService.startPrintingProcess(job.shortId, io);

    expect(prisma.printJob.updateMany).not.toHaveBeenCalled();
    expect(room.emit).not.toHaveBeenCalled();
  });

  test('does not dispatch a device that is not ACTIVE or has no approval evidence', async () => {
    const job = makeDeviceJob({
      printerDevice: {
        ...makeDeviceJob().printerDevice,
        status: 'PENDING_APPROVAL',
        approvedAt: null
      }
    });
    prisma.printJob.findUnique.mockResolvedValueOnce(job);
    const { io, room } = createIo();

    await queueService.startPrintingProcess(job.shortId, io);

    expect(prisma.printJob.updateMany).not.toHaveBeenCalled();
    expect(room.emit).not.toHaveBeenCalled();
  });

  test('restores PRINTING to WAITING if the mapping changes after atomic claim', async () => {
    const initial = makeDeviceJob();
    const changed = makeDeviceJob({
      printerDevice: {
        ...initial.printerDevice,
        status: 'DISABLED'
      }
    });
    prisma.printJob.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed);
    prisma.printJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const { io, room } = createIo();

    await queueService.startPrintingProcess(initial.shortId, io);

    expect(prisma.printJob.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        shortId: initial.shortId,
        status: 'PRINTING',
        printerDeviceId: 'device-epson'
      },
      data: { status: 'WAITING' }
    });
    expect(room.emit).not.toHaveBeenCalled();
  });

  test('keeps legacy Machine-level jobs on the old path even when multi-printer gate is disabled', async () => {
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'false';
    const legacy = makeDeviceJob({
      shortId: 'JOB_LEGACY_001',
      printerDeviceId: null,
      printerDevice: null
    });
    prisma.printJob.findUnique
      .mockResolvedValueOnce(legacy)
      .mockResolvedValueOnce(legacy);
    const { io, room } = createIo();

    await queueService.startPrintingProcess(legacy.shortId, io);

    expect(prisma.printJob.updateMany).toHaveBeenCalledWith({
      where: {
        shortId: legacy.shortId,
        status: 'WAITING',
        printerDeviceId: null
      },
      data: { status: 'PRINTING' }
    });
    const emitted = room.emit.mock.calls.find(([event]) => event === 'physical_print_job');
    expect(emitted).toBeDefined();
    expect(emitted[1].printerDeviceId).toBeUndefined();
    expect(emitted[1].windowsPrinterName).toBeUndefined();
  });
});
