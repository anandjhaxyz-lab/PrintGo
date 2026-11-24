jest.mock('../src/utils/prisma', () => ({
  machine: { findUnique: jest.fn() },
  printJob: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  $transaction: jest.fn()
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock('../src/utils/stateMachine', () => ({
  isValidJobTransition: jest.fn(() => true)
}));

jest.mock('../src/services/printerAvailability.service', () => ({
  getMachineAvailability: jest.fn().mockResolvedValue(null),
  computePrinterAvailability: jest.fn()
}));

jest.mock('../src/services/printerAgentProtocol.service', () => ({
  handlePrinterAgentHello: jest.fn(),
  handlePrinterDeviceRegistryRequest: jest.fn(),
  handlePrinterInventoryReport: jest.fn(),
  handlePrinterDeviceTelemetry: jest.fn()
}));

jest.mock('../src/services/queueService', () => ({
  startPrintingProcess: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../src/modules/payments/payments.service', () => ({
  refundPayment: jest.fn().mockResolvedValue({ status: 'REFUNDED' })
}));

const prisma = require('../src/utils/prisma');
const queueService = require('../src/services/queueService');
const paymentsService = require('../src/modules/payments/payments.service');
const setupSockets = require('../src/socket');

const makeHarness = () => {
  const handlers = {};
  let connectionHandler;
  const room = { emit: jest.fn() };
  const io = {
    use: jest.fn(),
    on: jest.fn((event, callback) => {
      if (event === 'connection') connectionHandler = callback;
    }),
    to: jest.fn(() => room)
  };
  const socket = {
    id: 'agent-socket-1',
    userType: 'printer',
    machineId: 'machine-a',
    machineName: 'Test Printer PC',
    join: jest.fn(),
    emit: jest.fn(),
    on: jest.fn((event, callback) => {
      handlers[event] = callback;
    })
  };

  setupSockets(io);
  connectionHandler(socket);
  return { io, socket, handlers, room };
};

const makeDeviceJob = () => ({
  id: 'db-job-1',
  shortId: 'JOB_DEVICE_001',
  machineId: 'machine-a',
  status: 'PRINTING',
  payment: { status: 'SUCCESS' },
  printerDeviceId: 'device-epson',
  printerWindowsQueueName: 'Epson L6460',
  printerDevice: { windowsPrinterName: 'Epson L6460 (may have changed)' }
});

describe('Socket reconciliation request consumption', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.printJob.findMany.mockResolvedValue([]);
    prisma.printJob.findUnique.mockReset();
    prisma.printJob.update.mockReset();
    paymentsService.refundPayment.mockReset();
    paymentsService.refundPayment.mockResolvedValue({ status: 'REFUNDED' });
  });

  test('does not consume a reconciliation slot when PrinterDevice identity is invalid', async () => {
    const { socket, handlers } = makeHarness();
    const job = makeDeviceJob();
    const tx = {
      printJob: {
        findUnique: jest.fn().mockResolvedValue(job),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const request = {
      requestId: 'reconcile-request-001',
      jobId: job.shortId,
      status: 'NOT_DISPATCHED',
      printerDeviceId: 'device-hp',
      windowsPrinterName: 'HP LaserJet'
    };
    const active = {
      requestId: request.requestId,
      jobIds: new Set([job.shortId]),
      createdAt: Date.now()
    };
    socket.activeReconciliation = active;

    await handlers.job_reconciliation_report(request);

    expect(active.jobIds.has(job.shortId)).toBe(true);
    expect(tx.printJob.updateMany).not.toHaveBeenCalled();
    expect(queueService.startPrintingProcess).not.toHaveBeenCalled();
  });

  test('does not request a refund for a pending payment after Agent rejects before driver submission', async () => {
    const { handlers } = makeHarness();
    const job = {
      ...makeDeviceJob(),
      paymentId: 'payment-pending',
      payment: { status: 'PENDING' }
    };
    prisma.printJob.findUnique.mockResolvedValue(job);
    prisma.printJob.update.mockResolvedValue({ ...job, status: 'FAILED' });

    await handlers.print_spooler_error({
      jobId: job.shortId,
      printerDeviceId: job.printerDeviceId,
      windowsPrinterName: job.printerWindowsQueueName,
      error: 'DEVICE_NOT_ACTIVE'
    });

    expect(prisma.printJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { shortId: job.shortId },
      data: { status: 'FAILED' },
      include: expect.objectContaining({ payment: true })
    }));
    expect(paymentsService.refundPayment).not.toHaveBeenCalled();
  });

  test('requests an idempotent refund when Agent rejects a job with successful payment before driver submission', async () => {
    const { handlers } = makeHarness();
    const job = {
      ...makeDeviceJob(),
      paymentId: 'payment-success',
      payment: { status: 'SUCCESS' }
    };
    prisma.printJob.findUnique.mockResolvedValue(job);
    prisma.printJob.update.mockResolvedValue({ ...job, status: 'FAILED' });

    await handlers.print_spooler_error({
      jobId: job.shortId,
      printerDeviceId: job.printerDeviceId,
      windowsPrinterName: job.printerWindowsQueueName,
      error: 'DEVICE_NOT_ACTIVE'
    });

    expect(paymentsService.refundPayment).toHaveBeenCalledWith(
      job.shortId,
      null,
      expect.stringContaining('DEVICE_NOT_ACTIVE'),
      expect.objectContaining({
        initiatedBy: 'SYSTEM',
        preserveJobStatus: true,
        idempotencyKey: expect.stringContaining(job.id)
      })
    );
  });

  test('consumes the reconciliation slot after exact job/device/Machine validation', async () => {
    const { io, socket, handlers } = makeHarness();
    const job = makeDeviceJob();
    const tx = {
      printJob: {
        findUnique: jest.fn().mockResolvedValue(job),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const request = {
      requestId: 'reconcile-request-002',
      jobId: job.shortId,
      status: 'NOT_DISPATCHED',
      printerDeviceId: job.printerDeviceId,
      windowsPrinterName: job.printerWindowsQueueName
    };
    const active = {
      requestId: request.requestId,
      jobIds: new Set([job.shortId]),
      createdAt: Date.now()
    };
    socket.activeReconciliation = active;

    await handlers.job_reconciliation_report(request);

    expect(active.jobIds.has(job.shortId)).toBe(false);
    expect(tx.printJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: job.id,
        shortId: job.shortId,
        machineId: socket.machineId,
        status: 'PRINTING'
      },
      data: { status: 'WAITING' }
    });
    expect(queueService.startPrintingProcess).toHaveBeenCalledWith(job.shortId, io);
  });
});
