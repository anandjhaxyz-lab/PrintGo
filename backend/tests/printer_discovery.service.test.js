const {
  recordPrinterDiscoveryInventory,
  listApprovedPrinterDevices,
  approvePrinterDiscovery,
  DISCOVERY_MAX_AGE_MS
} = require('../src/services/printerDiscovery.service');

const superadmin = { id: 'admin-a', email: 'admin@example.com', role: 'SUPERADMIN' };

function makeApprovalFixture(overrides = {}) {
  const discovery = {
    id: 'discovery-a',
    machineId: 'machine-a',
    windowsPrinterName: 'Epson L6460',
    driverName: 'Epson Driver',
    portName: 'USB001',
    connectionType: 'USB',
    isDefault: true,
    lastSeenAt: new Date(),
    reviewStatus: 'DISCOVERED',
    approvedPrinterDeviceId: null,
    machine: { id: 'machine-a', name: 'Shop PC', status: 'ACTIVE', companyId: 'company-a' },
    ...overrides.discovery
  };
  const device = {
    id: 'device-a',
    machineId: 'machine-a',
    displayName: 'Epson Counter',
    windowsPrinterName: 'Epson L6460',
    status: 'ACTIVE'
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'machine-a' }]),
    printerDiscovery: {
      findUnique: jest.fn().mockResolvedValue(discovery),
      update: jest.fn().mockResolvedValue({ ...discovery, reviewStatus: 'APPROVED', approvedPrinterDeviceId: device.id })
    },
    printerDevice: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(device)
    },
    activityLog: { create: jest.fn().mockResolvedValue({ id: 'activity-a' }) }
  };
  const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };
  return { prisma, tx, discovery, device };
}

describe('Printer discovery persistence and approval', () => {
  test('persists exact queue names under a case-insensitive Machine-scoped key', async () => {
    const upsert = jest.fn(async ({ create }) => ({ id: 'discovery-a', ...create }));
    const tx = { printerDiscovery: { upsert } };
    const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };

    await recordPrinterDiscoveryInventory(prisma, 'machine-a', [{
      windowsPrinterName: 'Epson L6460',
      driverName: 'Epson Driver',
      portName: 'USB001',
      connectionType: 'USB',
      printerStatus: 3,
      detectedErrorState: 0,
      workOffline: false,
      shared: false,
      network: false,
      isDefault: true
    }]);

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { machineId_queueNameKey: { machineId: 'machine-a', queueNameKey: 'epson l6460' } },
      create: expect.objectContaining({
        machineId: 'machine-a',
        windowsPrinterName: 'Epson L6460',
        printerStatus: '3',
        reviewStatus: 'DISCOVERED'
      }),
      update: expect.objectContaining({ lastSeenAt: expect.any(Date) })
    }));
    expect(upsert.mock.calls[0][0].update).not.toHaveProperty('reviewStatus');
    expect(upsert.mock.calls[0][0].update).not.toHaveProperty('approvedPrinterDeviceId');
  });

  test('lists ACTIVE and DISABLED registered printers with only unexpired dispatch leases', async () => {
    const liveExpiresAt = new Date(Date.now() + 30000);
    const expiredAt = new Date(Date.now() - 30000);
    const devices = [
      {
        id: 'device-live',
        status: 'ACTIVE',
        printerQrs: [],
        dispatchLease: {
          jobShortId: 'JOB_LIVE',
          expiresAt: liveExpiresAt,
          releasedAt: null
        }
      },
      {
        id: 'device-disabled',
        status: 'DISABLED',
        printerQrs: [],
        dispatchLease: {
          jobShortId: 'JOB_EXPIRED',
          expiresAt: expiredAt,
          releasedAt: null
        }
      }
    ];
    const prisma = {
      printerDevice: {
        findMany: jest.fn().mockResolvedValue(devices),
        count: jest.fn().mockResolvedValue(2)
      }
    };

    const result = await listApprovedPrinterDevices(superadmin, {}, prisma);

    expect(prisma.printerDevice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: { in: ['ACTIVE', 'DISABLED', 'MAINTENANCE'] },
        approvedAt: { not: null },
        windowsPrinterName: { not: null }
      },
      include: expect.objectContaining({
        dispatchLease: {
          select: { jobShortId: true, expiresAt: true, releasedAt: true }
        }
      })
    }));
    expect(result.devices[0].dispatchLease).toEqual({
      jobShortId: 'JOB_LIVE',
      expiresAt: liveExpiresAt
    });
    expect(result.devices[1].dispatchLease).toBeNull();
  });

  test('creates an ACTIVE PrinterDevice only after explicit Admin approval', async () => {
    const { prisma, tx, device } = makeApprovalFixture();
    const result = await approvePrinterDiscovery('discovery-a', { displayName: 'Epson Counter' }, superadmin, prisma);

    expect(result).toEqual({ device, alreadyApproved: false });
    expect(tx.$queryRaw.mock.calls.map(([strings]) => strings.join(''))).toEqual([
      expect.stringContaining('FROM "Machine"'),
      expect.stringContaining('FROM "PrinterDiscovery"')
    ]);
    expect(tx.printerDevice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        machineId: 'machine-a',
        windowsPrinterName: 'Epson L6460',
        displayName: 'Epson Counter',
        status: 'ACTIVE',
        approvedBy: 'admin-a'
      })
    });
    expect(tx.printerDiscovery.update).toHaveBeenCalledWith({
      where: { id: 'discovery-a' },
      data: { reviewStatus: 'APPROVED', approvedPrinterDeviceId: 'device-a' }
    });
    expect(tx.activityLog.create).toHaveBeenCalled();
  });

  test('blocks cross-company approval', async () => {
    const { prisma, tx } = makeApprovalFixture({
      discovery: { machine: { id: 'machine-a', name: 'Other Shop', status: 'ACTIVE', companyId: 'company-b' } }
    });
    await expect(approvePrinterDiscovery(
      'discovery-a', {}, { id: 'franchise-a', role: 'FRANCHISEE', companyId: 'company-a' }, prisma
    )).rejects.toMatchObject({ statusCode: 403 });
    expect(tx.printerDevice.create).not.toHaveBeenCalled();
  });

  test('blocks stale discovery records older than the 24-hour review window', async () => {
    const staleAt = new Date(Date.now() - DISCOVERY_MAX_AGE_MS - 1000);
    const { prisma, tx } = makeApprovalFixture({ discovery: { lastSeenAt: staleAt } });
    await expect(approvePrinterDiscovery('discovery-a', {}, superadmin, prisma))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(tx.printerDevice.create).not.toHaveBeenCalled();
  });

  test('enforces the ten-printer-per-PC ceiling', async () => {
    const { prisma, tx } = makeApprovalFixture();
    tx.printerDevice.count.mockResolvedValue(10);
    await expect(approvePrinterDiscovery('discovery-a', {}, superadmin, prisma))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(tx.printerDevice.create).not.toHaveBeenCalled();
  });

  test('does not reactivate an already mapped but disabled Windows queue', async () => {
    const { prisma, tx } = makeApprovalFixture();
    tx.printerDevice.findFirst.mockResolvedValue({ id: 'device-old', status: 'DISABLED' });
    await expect(approvePrinterDiscovery('discovery-a', {}, superadmin, prisma))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(tx.printerDevice.create).not.toHaveBeenCalled();
  });

  test('returns an existing approval idempotently', async () => {
    const { prisma, tx, device } = makeApprovalFixture({
      discovery: { reviewStatus: 'APPROVED', approvedPrinterDeviceId: 'device-a' }
    });
    tx.printerDevice.findUnique.mockResolvedValue(device);
    const result = await approvePrinterDiscovery('discovery-a', {}, superadmin, prisma);
    expect(result).toEqual({ device, alreadyApproved: true });
    expect(tx.printerDevice.create).not.toHaveBeenCalled();
  });

  test('safely transfers default status from existing placeholder to new approved printer without unique violation', async () => {
    const { prisma, tx, device } = makeApprovalFixture();
    const legacyPlaceholder = {
      id: 'placeholder-legacy-1',
      machineId: 'machine-a',
      isDefault: true,
      status: 'DISCOVERY_REQUIRED',
      windowsPrinterName: null
    };
    tx.printerDevice.update = jest.fn().mockResolvedValue({ ...legacyPlaceholder, isDefault: false });
    // First findFirst checks for mappedQueue (returns null), second checks for existingDefault (returns placeholder)
    tx.printerDevice.findFirst = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacyPlaceholder);

    const result = await approvePrinterDiscovery('discovery-a', { displayName: 'Epson Counter', isDefault: true }, superadmin, prisma);

    expect(result).toEqual({ device, alreadyApproved: false });
    // Proves legacy placeholder had its default status set to false before creating new device
    expect(tx.printerDevice.update).toHaveBeenCalledWith({
      where: { id: 'placeholder-legacy-1' },
      data: { isDefault: false }
    });
    expect(tx.printerDevice.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        isDefault: true
      })
    }));
    // Proves PRINTER_DEVICE_DEFAULT_TRANSFERRED audit log was created
    expect(tx.activityLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'PRINTER_DEVICE_DEFAULT_TRANSFERRED',
        details: expect.stringContaining('placeholder-legacy-1')
      })
    }));
  });

  test('strictly rejects null/null company equality for non-superadmin', async () => {
    const { prisma, tx } = makeApprovalFixture({
      discovery: { machine: { id: 'machine-a', name: 'Null Co Shop', status: 'ACTIVE', companyId: null } }
    });
    const nullUser = { id: 'user-null', role: 'FRANCHISEE', companyId: null };

    await expect(approvePrinterDiscovery('discovery-a', {}, nullUser, prisma))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(tx.printerDevice.create).not.toHaveBeenCalled();
  });
});
