process.env.NODE_ENV = 'test';
process.env.QUEUE_REDIS_REQUIRED = 'false';

jest.mock('../src/utils/prisma', () => ({
  printJob: {
    findUnique: jest.fn(),
    updateMany: jest.fn()
  },
  printHistory: { create: jest.fn() },
  refund: {
    findFirst: jest.fn(),
    create: jest.fn()
  },
  reconciliationRecord: {
    create: jest.fn()
  }
}));

jest.mock('../src/services/redisClient', () => ({ connection: null }));
jest.mock('../src/utils/stateMachine', () => ({
  isValidJobTransition: jest.fn(() => true)
}));
jest.mock('../src/modules/payments/payments.service', () => ({
  refundPayment: jest.fn().mockResolvedValue({ status: 'REFUNDED' })
}));

const prisma = require('../src/utils/prisma');
const queueService = require('../src/services/queueService');
const paymentsService = require('../src/modules/payments/payments.service');

const makeDeviceJob = (overrides = {}) => ({
  id: 'db-job-1',
  shortId: 'JOB_DEVICE_001',
  machineId: 'machine-a',
  printerDeviceId: 'device-epson',
  printerWindowsQueueName: 'Epson L6460',
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
    prisma.printHistory.create.mockResolvedValue({ id: 'history-1' });
    prisma.refund.findFirst.mockResolvedValue(null);
    prisma.refund.create.mockResolvedValue({ id: 'refund-failed-1', status: 'FAILED' });
    prisma.reconciliationRecord.create.mockResolvedValue({ id: 'rec-1' });
    paymentsService.refundPayment.mockResolvedValue({ status: 'REFUNDED' });
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
        printerDeviceId: 'device-epson',
        printAttempts: { lt: 3 },
        legacyAttemptsUnknown: false
      },
      data: {
        status: 'PRINTING',
        printAttempts: { increment: 1 }
      }
    });
    expect(io.to).toHaveBeenCalledWith('machine_machine-a');
    expect(room.emit).toHaveBeenCalledWith('physical_print_job', expect.objectContaining({
      jobId: job.shortId,
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    }));
  });

  test('cancels a paid device-bound job and refunds when the feature gate is disabled', async () => {
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'false';
    const job = makeDeviceJob({
      paymentId: 'payment-1',
      payment: { id: 'payment-1', status: 'SUCCESS' }
    });
    prisma.printJob.findUnique.mockResolvedValueOnce(job);
    const { io, room } = createIo();

    await queueService.startPrintingProcess(job.shortId, io);

    expect(prisma.printJob.updateMany).toHaveBeenCalledWith({
      where: {
        shortId: job.shortId,
        status: 'WAITING',
        printerDeviceId: 'device-epson'
      },
      data: { status: 'CANCELLED' }
    });
    expect(prisma.printHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        printJobId: job.id,
        success: false,
        errorDetails: expect.stringContaining('DISPATCH_FEATURE_DISABLED')
      })
    });
    expect(paymentsService.refundPayment).toHaveBeenCalledWith(
      job.shortId,
      null,
      expect.stringContaining('DISPATCH_FEATURE_DISABLED'),
      expect.objectContaining({
        initiatedBy: 'SYSTEM',
        preserveJobStatus: true,
        idempotencyKey: expect.stringContaining(job.id)
      })
    );
    expect(room.emit).toHaveBeenCalledWith('job_status_changed', expect.objectContaining({
      shortId: job.shortId,
      status: 'CANCELLED',
      code: 'DISPATCH_FEATURE_DISABLED'
    }));
    expect(room.emit).not.toHaveBeenCalledWith('physical_print_job', expect.any(Object));
  });

  test('cancels and refunds a job when its stored Windows queue snapshot no longer matches the current mapping', async () => {
    const job = makeDeviceJob({
      paymentId: 'payment-snapshot',
      payment: { id: 'payment-snapshot', status: 'SUCCESS' },
      printerDevice: {
        ...makeDeviceJob().printerDevice,
        windowsPrinterName: 'Epson L6460 (Copy 1)'
      }
    });
    prisma.printJob.findUnique.mockResolvedValueOnce(job);
    const { io, room } = createIo();

    await queueService.startPrintingProcess(job.shortId, io);

    expect(prisma.printJob.updateMany).toHaveBeenCalledWith({
      where: {
        shortId: job.shortId,
        status: 'WAITING',
        printerDeviceId: 'device-epson'
      },
      data: { status: 'CANCELLED' }
    });
    expect(paymentsService.refundPayment).toHaveBeenCalledWith(
      job.shortId,
      null,
      expect.stringContaining('PRINTER_QUEUE_SNAPSHOT_MISMATCH'),
      expect.objectContaining({ preserveJobStatus: true })
    );
    expect(room.emit).not.toHaveBeenCalledWith('physical_print_job', expect.any(Object));
  });

  test('cancels a paid job when its device is not ACTIVE or lacks approval evidence', async () => {
    const job = makeDeviceJob({
      paymentId: 'payment-2',
      payment: { id: 'payment-2', status: 'SUCCESS' },
      printerDevice: {
        ...makeDeviceJob().printerDevice,
        status: 'PENDING_APPROVAL',
        approvedAt: null
      }
    });
    prisma.printJob.findUnique.mockResolvedValueOnce(job);
    const { io, room } = createIo();

    await queueService.startPrintingProcess(job.shortId, io);

    expect(prisma.printJob.updateMany).toHaveBeenCalledWith({
      where: {
        shortId: job.shortId,
        status: 'WAITING',
        printerDeviceId: 'device-epson'
      },
      data: { status: 'CANCELLED' }
    });
    expect(paymentsService.refundPayment).toHaveBeenCalledTimes(1);
    expect(room.emit).not.toHaveBeenCalledWith('physical_print_job', expect.any(Object));
  });

  test('fails a claimed job and refunds if the mapping changes before Agent emission', async () => {
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
      data: { status: 'FAILED' }
    });
    expect(prisma.printHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        printJobId: initial.id,
        success: false,
        errorDetails: expect.stringContaining('PRINTER_DEVICE_CHANGED_BEFORE_DISPATCH')
      })
    });
    expect(room.emit).toHaveBeenCalledWith('job_status_changed', expect.objectContaining({
      shortId: initial.shortId,
      status: 'FAILED',
      code: 'PRINTER_DEVICE_CHANGED_BEFORE_DISPATCH'
    }));
    expect(room.emit).not.toHaveBeenCalledWith('physical_print_job', expect.any(Object));
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
        printerDeviceId: null,
        printAttempts: { lt: 3 },
        legacyAttemptsUnknown: false
      },
      data: {
        status: 'PRINTING',
        printAttempts: { increment: 1 }
      }
    });
    const emitted = room.emit.mock.calls.find(([event]) => event === 'physical_print_job');
    expect(emitted).toBeDefined();
    expect(emitted[1].printerDeviceId).toBeUndefined();
    expect(emitted[1].windowsPrinterName).toBeUndefined();
  });

  test('persists a durable FAILED Refund and ReconciliationRecord when automatic refund fails', async () => {
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'false';
    const refundError = new Error('Gateway network timeout during automatic refund');
    paymentsService.refundPayment.mockRejectedValueOnce(refundError);

    const job = makeDeviceJob({
      paymentId: 'payment-failed-refund',
      payment: { id: 'payment-failed-refund', amount: 25, currency: 'INR', status: 'SUCCESS' }
    });
    prisma.printJob.findUnique
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce(job);

    const { io, room } = createIo();
    await queueService.startPrintingProcess(job.shortId, io);

    // Job is cancelled due to feature gate
    expect(prisma.printJob.updateMany).toHaveBeenCalledWith({
      where: {
        shortId: job.shortId,
        status: 'WAITING',
        printerDeviceId: job.printerDeviceId
      },
      data: { status: 'CANCELLED' }
    });

    // Refund was attempted
    expect(paymentsService.refundPayment).toHaveBeenCalledWith(
      job.shortId,
      null,
      expect.stringContaining('DISPATCH_FEATURE_DISABLED'),
      expect.objectContaining({ preserveJobStatus: true })
    );

    // Durable failed refund is persisted with retryEligible = true and preserved failureReason
    expect(prisma.refund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: 'payment-failed-refund',
        printJobId: job.id,
        status: 'FAILED',
        retryEligible: true,
        failureReason: refundError.message,
        initiatedBy: 'SYSTEM'
      })
    });

    // Durable reconciliation record is created with FAILED_AUTOMATIC_REFUND
    expect(prisma.reconciliationRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paymentId: 'payment-failed-refund',
        refundId: 'refund-failed-1',
        printJobId: job.id,
        status: 'PENDING_RECONCILIATION',
        discrepancyType: 'FAILED_AUTOMATIC_REFUND',
        details: expect.stringContaining('Gateway network timeout')
      })
    });

    // Physical print job was blocked
    expect(room.emit).not.toHaveBeenCalledWith('physical_print_job', expect.any(Object));
  });
});
