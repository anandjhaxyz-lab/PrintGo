jest.mock('../src/utils/prisma', () => ({
  $transaction: jest.fn(),
  printerDiscovery: {
    findMany: jest.fn()
  },
  printerDevice: {
    findMany: jest.fn(),
    findUnique: jest.fn()
  }
}));

jest.mock('../src/services/printerQr.service', () => ({
  verifyMachineAccess: jest.fn()
}));

const prisma = require('../src/utils/prisma');
const printerQrService = require('../src/services/printerQr.service');
const service = require('../src/modules/admin/printerDevice.admin.service');

const user = { id: 'admin-1', role: 'SUPERADMIN' };

describe('Admin PrinterDevice mapping and approval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    printerQrService.verifyMachineAccess.mockResolvedValue({
      id: 'machine-a',
      companyId: 'company-a'
    });
  });

  test('binds a present discovered queue to the unbound legacy placeholder as PENDING_APPROVAL', async () => {
    const discovery = {
      id: 'discovery-1',
      machineId: 'machine-a',
      windowsPrinterName: 'Epson L6460',
      queueNameKey: 'epson l6460',
      driverName: 'Epson Driver',
      portName: 'USB001',
      connectionType: 'USB',
      lastSeenAt: new Date('2026-11-19T00:00:00.000Z'),
      printerDeviceId: null,
      isPresent: true
    };
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'machine-a' }]),
      printerDiscovery: {
        findFirst: jest.fn().mockResolvedValue(discovery),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      printerDevice: {
        findFirst: jest.fn()
          .mockResolvedValueOnce(null) // no duplicate queue mapping
          .mockResolvedValueOnce({ id: 'legacy-device', isDefault: true }), // unbound legacy placeholder
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({
          id: 'legacy-device',
          machineId: 'machine-a',
          displayName: 'Epson L6460',
          windowsPrinterName: 'Epson L6460',
          status: 'PENDING_APPROVAL',
          approvedAt: null,
          approvedBy: null
        })
      }
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const result = await service.bindDiscoveredPrinterDevice(
      'machine-a',
      { discoveryId: 'discovery-1' },
      user
    );

    expect(result.alreadyBound).toBe(false);
    expect(result.device.status).toBe('PENDING_APPROVAL');
    expect(result.device.windowsPrinterName).toBe('Epson L6460');
    expect(result.device.approvedAt).toBeNull();
    expect(tx.printerDevice.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'legacy-device' },
      data: expect.objectContaining({
        windowsPrinterName: 'Epson L6460',
        driverName: 'Epson Driver',
        portName: 'USB001',
        connectionType: 'USB',
        status: 'PENDING_APPROVAL',
        approvedAt: null,
        approvedBy: null
      })
    }));
    expect(tx.printerDiscovery.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'discovery-1',
        machineId: 'machine-a',
        isPresent: true,
        printerDeviceId: null
      },
      data: { printerDeviceId: 'legacy-device' }
    });
  });

  test('creates an additional non-default device when no legacy placeholder is available', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'machine-a' }]),
      printerDiscovery: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'discovery-2',
          machineId: 'machine-a',
          windowsPrinterName: 'HP LaserJet',
          queueNameKey: 'hp laserjet',
          driverName: 'HP Driver',
          portName: 'IP_192.0.2.10',
          connectionType: 'Network',
          lastSeenAt: new Date(),
          printerDeviceId: null,
          isPresent: true
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      printerDevice: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockResolvedValue({
          id: 'device-2',
          machineId: 'machine-a',
          windowsPrinterName: 'HP LaserJet',
          status: 'PENDING_APPROVAL',
          isDefault: false
        })
      }
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const result = await service.bindDiscoveredPrinterDevice(
      'machine-a',
      { discoveryId: 'discovery-2', displayName: 'HP Counter Printer' },
      user
    );

    expect(result.device.status).toBe('PENDING_APPROVAL');
    expect(tx.printerDevice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        machineId: 'machine-a',
        displayName: 'HP Counter Printer',
        windowsPrinterName: 'HP LaserJet',
        status: 'PENDING_APPROVAL',
        isDefault: false,
        sortOrder: 1,
        approvedAt: null,
        approvedBy: null
      })
    });
  });

  test('refuses to bind an 11th queue-bound device', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'machine-a' }]),
      printerDiscovery: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'discovery-11',
          machineId: 'machine-a',
          windowsPrinterName: 'Queue 11',
          queueNameKey: 'queue 11',
          isPresent: true,
          printerDeviceId: null
        })
      },
      printerDevice: {
        findFirst: jest.fn()
          .mockResolvedValueOnce(null) // no duplicate
          .mockResolvedValueOnce(null), // no placeholder
        count: jest.fn().mockResolvedValue(10),
        create: jest.fn(),
        update: jest.fn()
      }
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    await expect(service.bindDiscoveredPrinterDevice(
      'machine-a',
      { discoveryId: 'discovery-11' },
      user
    )).rejects.toThrow('limited to 10 queue-bound printers');

    expect(tx.printerDevice.create).not.toHaveBeenCalled();
    expect(tx.printerDevice.update).not.toHaveBeenCalled();
  });

  test('explicit Admin approval activates only a currently present exact mapped queue', async () => {
    const pendingDevice = {
      id: 'device-1',
      machineId: 'machine-a',
      windowsPrinterName: 'Epson L6460',
      status: 'PENDING_APPROVAL',
      approvedAt: null
    };
    const approvedDevice = {
      ...pendingDevice,
      status: 'ACTIVE',
      approvedAt: new Date(),
      approvedBy: 'admin-1'
    };
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'machine-a' }]),
      printerDevice: {
        findFirst: jest.fn().mockResolvedValue(pendingDevice),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(approvedDevice)
      },
      printerDiscovery: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'discovery-1',
          machineId: 'machine-a',
          printerDeviceId: 'device-1',
          queueNameKey: 'epson l6460',
          isPresent: true,
          lastSeenAt: new Date()
        })
      }
    };
    prisma.printerDevice.findUnique.mockResolvedValue({
      id: 'device-1',
      machineId: 'machine-a'
    });
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const result = await service.approvePrinterDevice('device-1', user);

    expect(result.alreadyApproved).toBe(false);
    expect(result.device.status).toBe('ACTIVE');
    expect(tx.printerDiscovery.findFirst).toHaveBeenCalledWith({
      where: {
        machineId: 'machine-a',
        printerDeviceId: 'device-1',
        isPresent: true,
        queueNameKey: 'epson l6460'
      }
    });
    expect(tx.printerDevice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'device-1',
        machineId: 'machine-a',
        status: 'PENDING_APPROVAL',
        windowsPrinterName: 'Epson L6460',
        approvedAt: null
      }),
      data: expect.objectContaining({
        status: 'ACTIVE',
        approvedAt: expect.any(Date),
        approvedBy: 'admin-1'
      })
    }));
  });

  test('blocks approval when the exact queue is absent from the latest inventory', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'machine-a' }]),
      printerDevice: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'device-1',
          machineId: 'machine-a',
          windowsPrinterName: 'Epson L6460',
          status: 'PENDING_APPROVAL',
          approvedAt: null
        }),
        updateMany: jest.fn()
      },
      printerDiscovery: {
        findFirst: jest.fn().mockResolvedValue(null)
      }
    };
    prisma.printerDevice.findUnique.mockResolvedValue({
      id: 'device-1',
      machineId: 'machine-a'
    });
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    await expect(service.approvePrinterDevice('device-1', user))
      .rejects.toThrow('not present in the latest Agent inventory');

    expect(tx.printerDevice.updateMany).not.toHaveBeenCalled();
  });

  test('rejects an approval for a device outside the Admin user machine scope', async () => {
    prisma.printerDevice.findUnique.mockResolvedValue({
      id: 'device-other',
      machineId: 'machine-other'
    });
    printerQrService.verifyMachineAccess.mockRejectedValue(new Error('Access denied'));

    await expect(service.approvePrinterDevice('device-other', {
      id: 'franchisee-1',
      role: 'FRANCHISEE',
      companyId: 'company-a'
    })).rejects.toThrow('Access denied');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
