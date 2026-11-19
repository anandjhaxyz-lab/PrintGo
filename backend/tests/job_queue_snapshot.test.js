jest.mock('../src/utils/prisma', () => ({
  session: { findUnique: jest.fn() },
  printerDevice: { findUnique: jest.fn() },
  document: { create: jest.fn() },
  machine: { findUnique: jest.fn() },
  printJob: { create: jest.fn() }
}));

jest.mock('../src/services/pricing.service', () => ({
  calculatePrice: jest.fn()
}));

const prisma = require('../src/utils/prisma');
const { calculatePrice } = require('../src/services/pricing.service');
const { createJob } = require('../src/modules/jobs/jobs.service');

describe('Device-bound PrintJob queue snapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.session.findUnique.mockResolvedValue({
      machineId: 'machine-a',
      printerDeviceId: 'device-epson',
      paymentMode: 'CASH_AT_COUNTER'
    });
    prisma.printerDevice.findUnique.mockResolvedValue({
      id: 'device-epson',
      machineId: 'machine-a',
      status: 'ACTIVE',
      approvedAt: new Date('2026-11-19T00:00:00.000Z'),
      windowsPrinterName: 'Epson L6460',
      isDefault: false
    });
    prisma.document.create.mockResolvedValue({ id: 'document-1' });
    calculatePrice.mockResolvedValue({
      cost: 12,
      pagesToPrint: 2,
      pricingSnapshot: { unitPrice: 6 }
    });
    prisma.printJob.create.mockResolvedValue({
      shortId: 'JOB-SNAPSHOT-1',
      printerDeviceId: 'device-epson',
      printerWindowsQueueName: 'Epson L6460'
    });
  });

  test('persists the exact server-approved queue name and ignores any client device mapping', async () => {
    await createJob({
      sessionId: 'session-1',
      machineId: 'machine-a',
      printerDeviceId: 'client-supplied-device',
      windowsPrinterName: 'Client supplied queue',
      file: {
        originalName: 'document.pdf',
        filename: 'stored-document.pdf',
        mimetype: 'application/pdf',
        size: 1024,
        pages: 2
      },
      settings: {
        color: 'bw',
        duplex: 'single',
        copies: 1,
        pageRangeType: 'all',
        customRange: null,
        paperSize: 'A4',
        paperType: 'plain'
      },
      paymentMode: 'CASHFREE_ONLINE',
      encryptedKey: 'encrypted-key',
      iv: 'iv-data'
    });

    expect(prisma.printerDevice.findUnique).toHaveBeenCalledWith({
      where: { id: 'device-epson' },
      select: expect.objectContaining({
        id: true,
        machineId: true,
        status: true,
        approvedAt: true,
        windowsPrinterName: true
      })
    });
    expect(prisma.printJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        machineId: 'machine-a',
        printerDeviceId: 'device-epson',
        printerWindowsQueueName: 'Epson L6460',
        documentId: 'document-1',
        paymentMode: 'CASH_AT_COUNTER'
      }),
      include: { document: true }
    });
  });

  test('does not create a child queue snapshot for legacy Machine-level sessions', async () => {
    prisma.session.findUnique.mockResolvedValue({
      machineId: 'machine-a',
      printerDeviceId: 'legacy-device',
      paymentMode: 'CASH_AT_COUNTER'
    });
    prisma.printerDevice.findUnique.mockResolvedValue({
      id: 'legacy-device',
      machineId: 'machine-a',
      status: 'DISCOVERY_REQUIRED',
      approvedAt: null,
      windowsPrinterName: null,
      isDefault: true
    });

    await createJob({
      sessionId: 'legacy-session',
      machineId: 'machine-a',
      file: {
        originalName: 'legacy.pdf',
        filename: 'legacy.pdf',
        mimetype: 'application/pdf',
        size: 512,
        pages: 1
      },
      settings: {
        color: 'bw',
        duplex: 'single',
        copies: 1,
        pageRangeType: 'all',
        customRange: null,
        paperSize: 'A4',
        paperType: 'plain'
      }
    });

    expect(prisma.printJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        machineId: 'machine-a',
        printerDeviceId: null,
        printerWindowsQueueName: null
      }),
      include: { document: true }
    });
  });
});
