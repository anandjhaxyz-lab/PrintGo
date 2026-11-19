const {
  disablePrinterDevice,
  enablePrinterDevice,
  remapPrinterDevice
} = require('../src/services/printerDeviceAdmin.service');

const superadmin = { id: 'admin-a', email: 'admin@example.com', role: 'SUPERADMIN' };
const franchisee = { id: 'admin-b', role: 'FRANCHISEE', companyId: 'company-a' };

function fixtures({ device = {}, discovery = {}, lease = null } = {}) {
  const baseDevice = {
    id: 'device-a',
    machineId: 'machine-a',
    displayName: 'Epson Counter',
    windowsPrinterName: 'Epson L6460',
    status: 'ACTIVE',
    approvedAt: new Date(),
    machine: { id: 'machine-a', name: 'Shop PC', status: 'ACTIVE', companyId: 'company-a' },
    ...device
  };
  const baseDiscovery = {
    id: 'discovery-b',
    machineId: 'machine-a',
    windowsPrinterName: 'Epson L6460 (Copy 1)',
    driverName: 'Updated Epson Driver',
    portName: 'USB002',
    connectionType: 'USB',
    lastSeenAt: new Date(),
    reviewStatus: 'DISCOVERED',
    approvedPrinterDeviceId: null,
    ...discovery
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'machine-a' }]),
    printerDevice: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(async ({ data }) => ({ ...baseDevice, ...data })),
    },
    printerDiscovery: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue({
        ...baseDiscovery,
        reviewStatus: 'APPROVED',
        approvedPrinterDeviceId: 'device-a'
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({ ...baseDiscovery, reviewStatus: 'APPROVED', approvedPrinterDeviceId: 'device-a' })
    },
    printerDeviceDispatchLease: {
      findUnique: jest.fn().mockResolvedValue(lease)
    },
    activityLog: {
      create: jest.fn().mockResolvedValue({ id: 'activity-a' })
    }
  };
  const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };
  return { tx, prisma, device: baseDevice, discovery: baseDiscovery };
}

describe('Admin printer device disable/remap controls', () => {
  test('disables an active printer under a Machine/device row lock and writes an audit record', async () => {
    const f = fixtures();
    f.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(f.device);

    const result = await disablePrinterDevice('device-a', {
      reason: 'Client requested temporary service pause'
    }, superadmin, f.prisma);

    expect(result.alreadyDisabled).toBe(false);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(f.tx.$queryRaw.mock.calls.map(([strings]) => strings.join(''))).toEqual([
      expect.stringContaining('FROM "Machine"'),
      expect.stringContaining('FROM "PrinterDevice"')
    ]);
    expect(f.tx.printerDevice.update).toHaveBeenCalledWith({
      where: { id: 'device-a' },
      data: { status: 'DISABLED', healthStatus: 'UNKNOWN' },
      include: { machine: { select: { id: true, name: true, companyId: true } } }
    });
    expect(f.tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PRINTER_DEVICE_DISABLED',
        userId: 'admin-a',
        machineId: 'machine-a',
        details: expect.stringContaining('Client requested temporary service pause')
      })
    });
  });

  test('blocks disable while a live Agent dispatch lease exists', async () => {
    const f = fixtures({
      lease: {
        printerDeviceId: 'device-a',
        requestId: 'request-live',
        jobShortId: 'JOB_PRINTING',
        expiresAt: new Date(Date.now() + 30000),
        releasedAt: null
      }
    });
    f.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(f.device);

    await expect(disablePrinterDevice('device-a', {
      reason: 'Maintenance window requested'
    }, superadmin, f.prisma)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEVICE_DISPATCH_IN_PROGRESS'
    });
    expect(f.tx.printerDevice.update).not.toHaveBeenCalled();
    expect(f.tx.activityLog.create).not.toHaveBeenCalled();
  });

  test('requires a meaningful operator reason and company ownership', async () => {
    const noReason = fixtures();
    await expect(disablePrinterDevice('device-a', { reason: 'no' }, superadmin, noReason.prisma))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(noReason.prisma.$transaction).not.toHaveBeenCalled();

    const crossCompany = fixtures({
      device: { machine: { id: 'machine-a', name: 'Other Shop', companyId: 'company-b' } }
    });
    crossCompany.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(crossCompany.device);

    await expect(disablePrinterDevice('device-a', {
      reason: 'Disable for maintenance request'
    }, franchisee, crossCompany.prisma)).rejects.toMatchObject({ statusCode: 403 });
    expect(crossCompany.tx.printerDevice.update).not.toHaveBeenCalled();
  });

  test('returns idempotently when a printer is already disabled', async () => {
    const disabled = fixtures({ device: { status: 'DISABLED' } });
    disabled.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(disabled.device);

    const result = await disablePrinterDevice('device-a', {
      reason: 'Do not dispatch this printer'
    }, superadmin, disabled.prisma);
    expect(result.alreadyDisabled).toBe(true);
    expect(disabled.tx.printerDevice.update).not.toHaveBeenCalled();
  });

  test('re-enables a disabled printer only after exact fresh same-Machine discovery', async () => {
    const f = fixtures({
      device: { status: 'DISABLED' },
      discovery: {
        windowsPrinterName: 'Epson L6460',
        queueNameKey: 'epson l6460',
        reviewStatus: 'APPROVED',
        approvedPrinterDeviceId: 'device-a'
      }
    });
    f.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(f.device);

    const result = await enablePrinterDevice('device-a', {
      reason: 'Hardware service completed'
    }, superadmin, f.prisma);

    expect(result.alreadyEnabled).toBe(false);
    expect(result.device.status).toBe('ACTIVE');
    expect(f.tx.printerDiscovery.findFirst).toHaveBeenCalledWith({
      where: {
        machineId: 'machine-a',
        queueNameKey: 'epson l6460',
        reviewStatus: 'APPROVED',
        approvedPrinterDeviceId: 'device-a',
        lastSeenAt: { gte: expect.any(Date) }
      }
    });
    expect(f.tx.printerDevice.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'device-a' },
      data: expect.objectContaining({
        status: 'ACTIVE',
        approvedBy: 'admin-a',
        healthStatus: 'UNKNOWN'
      })
    }));
    expect(f.tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PRINTER_DEVICE_ENABLED',
        machineId: 'machine-a',
        userId: 'admin-a'
      })
    });
  });

  test('blocks re-enable when the exact queue is not recently discovered or the Machine is inactive', async () => {
    const missingDiscovery = fixtures({
      device: { status: 'DISABLED' },
      discovery: {
        windowsPrinterName: 'Epson L6460',
        queueNameKey: 'epson l6460',
        reviewStatus: 'APPROVED',
        approvedPrinterDeviceId: 'device-a'
      }
    });
    missingDiscovery.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(missingDiscovery.device);
    missingDiscovery.tx.printerDiscovery.findFirst.mockResolvedValue(null);
    await expect(enablePrinterDevice('device-a', {
      reason: 'Service is complete'
    }, superadmin, missingDiscovery.prisma)).rejects.toMatchObject({ statusCode: 409 });
    expect(missingDiscovery.tx.printerDevice.update).not.toHaveBeenCalled();

    const inactiveMachine = fixtures({
      device: {
        status: 'DISABLED',
        machine: { id: 'machine-a', name: 'Shop PC', status: 'SUSPENDED', companyId: 'company-a' }
      }
    });
    inactiveMachine.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(inactiveMachine.device);
    await expect(enablePrinterDevice('device-a', {
      reason: 'Service is complete'
    }, superadmin, inactiveMachine.prisma)).rejects.toMatchObject({ statusCode: 409 });
    expect(inactiveMachine.tx.printerDevice.update).not.toHaveBeenCalled();
  });

  test('blocks re-enable while a live dispatch lease exists', async () => {
    const f = fixtures({
      device: { status: 'DISABLED' },
      lease: {
        printerDeviceId: 'device-a',
        requestId: 'request-live',
        jobShortId: 'JOB_PRINTING',
        expiresAt: new Date(Date.now() + 30000),
        releasedAt: null
      }
    });
    f.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(f.device);
    await expect(enablePrinterDevice('device-a', {
      reason: 'Service has been completed'
    }, superadmin, f.prisma)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEVICE_DISPATCH_IN_PROGRESS'
    });
    expect(f.tx.printerDevice.update).not.toHaveBeenCalled();
  });

  test('remaps an approved device only to a fresh unclaimed queue on the same Machine', async () => {
    const f = fixtures();
    f.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(f.device);
    f.tx.printerDiscovery.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(f.discovery);

    const result = await remapPrinterDevice('device-a', {
      discoveryId: 'discovery-b',
      reason: 'Original queue was renamed by Windows update'
    }, superadmin, f.prisma);

    expect(result.previousWindowsPrinterName).toBe('Epson L6460');
    expect(result.device.windowsPrinterName).toBe('Epson L6460 (Copy 1)');
    expect(result.device.status).toBe('ACTIVE');
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(f.tx.$queryRaw.mock.calls.map(([strings]) => strings.join(''))).toEqual([
      expect.stringContaining('FROM "Machine"'),
      expect.stringContaining('FROM "PrinterDevice"'),
      expect.stringContaining('FROM "PrinterDiscovery"')
    ]);
    expect(f.tx.printerDevice.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'device-a' },
      data: expect.objectContaining({
        windowsPrinterName: 'Epson L6460 (Copy 1)',
        driverName: 'Updated Epson Driver',
        portName: 'USB002',
        approvedBy: 'admin-a',
        healthStatus: 'UNKNOWN'
      })
    }));
    expect(f.tx.printerDiscovery.updateMany).toHaveBeenCalledWith({
      where: {
        machineId: 'machine-a',
        approvedPrinterDeviceId: 'device-a',
        id: { not: 'discovery-b' }
      },
      data: { reviewStatus: 'DISCOVERED', approvedPrinterDeviceId: null }
    });
    expect(f.tx.printerDiscovery.update).toHaveBeenCalledWith({
      where: { id: 'discovery-b' },
      data: { reviewStatus: 'APPROVED', approvedPrinterDeviceId: 'device-a' }
    });
    expect(f.tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PRINTER_DEVICE_REMAPPED',
        machineId: 'machine-a',
        userId: 'admin-a'
      })
    });
  });

  test('preserves DISABLED status when an Admin updates the Windows queue mapping', async () => {
    const f = fixtures({ device: { status: 'DISABLED' } });
    f.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(f.device);
    f.tx.printerDiscovery.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(f.discovery);

    const result = await remapPrinterDevice('device-a', {
      discoveryId: 'discovery-b',
      reason: 'Rebind after printer replacement'
    }, superadmin, f.prisma);
    expect(result.device.status).toBe('DISABLED');
    expect(f.tx.printerDevice.update.mock.calls[0][0].data).not.toHaveProperty('status');
  });

  test('rejects stale, foreign-Machine, or already mapped discovery targets', async () => {
    const stale = fixtures({ discovery: { lastSeenAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } });
    stale.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(stale.device);
    stale.tx.printerDiscovery.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(stale.discovery);
    await expect(remapPrinterDevice('device-a', {
      discoveryId: 'discovery-b', reason: 'Queue needs remapping'
    }, superadmin, stale.prisma)).rejects.toMatchObject({ statusCode: 409 });
    expect(stale.tx.printerDevice.update).not.toHaveBeenCalled();

    const foreign = fixtures({ discovery: { machineId: 'machine-b' } });
    foreign.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(foreign.device);
    foreign.tx.printerDiscovery.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-b' })
      .mockResolvedValueOnce(foreign.discovery);
    await expect(remapPrinterDevice('device-a', {
      discoveryId: 'discovery-b', reason: 'Queue needs remapping'
    }, superadmin, foreign.prisma)).rejects.toMatchObject({ statusCode: 409 });
    expect(foreign.tx.printerDevice.update).not.toHaveBeenCalled();

    const mapped = fixtures({ discovery: {
      reviewStatus: 'APPROVED',
      approvedPrinterDeviceId: 'device-other'
    } });
    mapped.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(mapped.device);
    mapped.tx.printerDiscovery.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(mapped.discovery);
    await expect(remapPrinterDevice('device-a', {
      discoveryId: 'discovery-b', reason: 'Queue needs remapping'
    }, superadmin, mapped.prisma)).rejects.toMatchObject({ statusCode: 409 });
    expect(mapped.tx.printerDevice.update).not.toHaveBeenCalled();
  });

  test('blocks remapping while a live dispatch lease exists and rejects a mapped target queue', async () => {
    const leased = fixtures({
      lease: {
        printerDeviceId: 'device-a',
        requestId: 'request-live',
        jobShortId: 'JOB_PRINTING',
        expiresAt: new Date(Date.now() + 30000),
        releasedAt: null
      }
    });
    leased.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(leased.device);
    leased.tx.printerDiscovery.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(leased.discovery);
    await expect(remapPrinterDevice('device-a', {
      discoveryId: 'discovery-b', reason: 'Queue needs remapping'
    }, superadmin, leased.prisma)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEVICE_DISPATCH_IN_PROGRESS'
    });
    expect(leased.tx.printerDevice.update).not.toHaveBeenCalled();

    const duplicate = fixtures();
    duplicate.tx.printerDevice.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(duplicate.device);
    duplicate.tx.printerDiscovery.findUnique
      .mockResolvedValueOnce({ machineId: 'machine-a' })
      .mockResolvedValueOnce(duplicate.discovery);
    duplicate.tx.printerDevice.findFirst.mockResolvedValue({ id: 'device-other', displayName: 'HP' });
    await expect(remapPrinterDevice('device-a', {
      discoveryId: 'discovery-b', reason: 'Queue needs remapping'
    }, superadmin, duplicate.prisma)).rejects.toMatchObject({ statusCode: 409 });
    expect(duplicate.tx.printerDevice.update).not.toHaveBeenCalled();
  });
});
