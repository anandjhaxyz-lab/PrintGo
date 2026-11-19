const AppError = require('../utils/AppError');

const MAX_PRINTER_DEVICES_PER_MACHINE = 10;
const DISCOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const toNullableString = (value) => (
  value === null || value === undefined ? null : String(value)
);

const recordPrinterDiscoveryInventory = async (prisma, machineId, discoveredPrinters, now = new Date()) => {
  if (!prisma?.$transaction || !machineId || !Array.isArray(discoveredPrinters)) {
    throw new Error('A database transaction, authenticated Machine and normalized inventory are required.');
  }

  return prisma.$transaction(async (tx) => Promise.all(discoveredPrinters.map((printer) => {
    const windowsPrinterName = String(printer.windowsPrinterName || '').trim();
    const queueNameKey = windowsPrinterName.toLowerCase();
    if (!windowsPrinterName || !queueNameKey) throw new Error('A discovered Windows queue must have a non-empty exact name.');

    const metadata = {
      windowsPrinterName,
      queueNameKey,
      driverName: printer.driverName || null,
      portName: printer.portName || null,
      connectionType: printer.connectionType || 'Unknown',
      printerStatus: toNullableString(printer.printerStatus),
      detectedErrorState: toNullableString(printer.detectedErrorState),
      workOffline: printer.workOffline ?? null,
      shared: printer.shared ?? null,
      network: printer.network ?? null,
      isDefault: printer.isDefault === true,
      lastSeenAt: now
    };

    return tx.printerDiscovery.upsert({
      where: { machineId_queueNameKey: { machineId, queueNameKey } },
      create: { machineId, ...metadata, reviewStatus: 'DISCOVERED' },
      // Preserve Admin review and approval link across later Agent reports.
      update: metadata
    });
  })));
};

const listPrinterDiscoveries = async (user, query = {}, prisma) => {
  const parsedLimit = Number(query.limit);
  const take = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 100;
  const where = { reviewStatus: 'DISCOVERED' };

  if (query.machineId) where.machineId = String(query.machineId);
  if (user && user.role !== 'SUPERADMIN') {
    if (!user.companyId) return { discoveries: [], total: 0 };
    where.machine = { companyId: user.companyId };
  }

  const [discoveries, total] = await Promise.all([
    prisma.printerDiscovery.findMany({
      where,
      take,
      include: { machine: { select: { id: true, name: true, location: true, status: true, companyId: true } } },
      orderBy: [{ lastSeenAt: 'desc' }, { windowsPrinterName: 'asc' }]
    }),
    prisma.printerDiscovery.count({ where })
  ]);
  return { discoveries, total };
};

const listApprovedPrinterDevices = async (user, query = {}, prisma) => {
  const parsedLimit = Number(query.limit);
  const take = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 100;
  const where = {
    status: 'ACTIVE',
    approvedAt: { not: null },
    windowsPrinterName: { not: null }
  };

  if (query.machineId) where.machineId = String(query.machineId);
  if (user && user.role !== 'SUPERADMIN') {
    if (!user.companyId) return { devices: [], total: 0 };
    where.machine = { companyId: user.companyId };
  }

  const [devices, total] = await Promise.all([
    prisma.printerDevice.findMany({
      where,
      take,
      include: {
        machine: { select: { id: true, name: true, location: true, companyId: true } },
        printerQrs: {
          where: { status: 'ACTIVE' },
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { id: true, publicCode: true, label: true, status: true, createdAt: true }
        }
      },
      orderBy: [{ machineId: 'asc' }, { sortOrder: 'asc' }, { displayName: 'asc' }]
    }),
    prisma.printerDevice.count({ where })
  ]);

  return {
    devices: devices.map((device) => ({
      ...device,
      activeQr: device.printerQrs?.[0] || null,
      printerQrs: undefined
    })),
    total
  };
};

const approvePrinterDiscovery = async (discoveryId, data = {}, user, prisma) => {
  if (!user || !['SUPERADMIN', 'FRANCHISEE'].includes(user.role)) {
    throw new AppError('Only an authorized Admin can approve a discovered printer.', 403);
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PrinterDiscovery" WHERE "id" = ${discoveryId} FOR UPDATE`;
    const discovery = await tx.printerDiscovery.findUnique({
      where: { id: discoveryId },
      include: { machine: { select: { id: true, name: true, status: true, companyId: true } } }
    });

    if (!discovery || !discovery.machine) throw new AppError('Printer discovery record not found.', 404);
    if (user.role !== 'SUPERADMIN' && discovery.machine.companyId !== user.companyId) {
      throw new AppError('Access denied: this printer belongs to another company.', 403);
    }

    if (discovery.reviewStatus === 'APPROVED' && discovery.approvedPrinterDeviceId) {
      const existingApproved = await tx.printerDevice.findUnique({ where: { id: discovery.approvedPrinterDeviceId } });
      if (existingApproved) return { device: existingApproved, alreadyApproved: true };
    }
    if (discovery.reviewStatus !== 'DISCOVERED') throw new AppError('This discovery has already been reviewed.', 409);
    if (discovery.machine.status !== 'ACTIVE') {
      throw new AppError('The Machine must be ACTIVE before a discovered printer can be approved.', 409);
    }

    const lastSeenAt = new Date(discovery.lastSeenAt).getTime();
    if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt > DISCOVERY_MAX_AGE_MS) {
      throw new AppError('This discovery is stale. Reconnect the Agent and refresh discovery before approval.', 409);
    }

    const displayName = data.displayName === undefined || data.displayName === null
      ? discovery.windowsPrinterName
      : (typeof data.displayName === 'string' ? data.displayName.trim() : '');
    if (!displayName || displayName.length > 120 || /[\u0000-\u001f\u007f]/.test(displayName)) {
      throw new AppError('displayName must be a non-empty label of at most 120 characters.', 400);
    }

    await tx.$queryRaw`SELECT "id" FROM "Machine" WHERE "id" = ${discovery.machineId} FOR UPDATE`;

    const mappedQueue = await tx.printerDevice.findFirst({
      where: {
        machineId: discovery.machineId,
        windowsPrinterName: { equals: discovery.windowsPrinterName, mode: 'insensitive' }
      }
    });
    if (mappedQueue) {
      throw new AppError('This Windows queue is already mapped to a PrinterDevice. Review that device instead of creating a duplicate.', 409);
    }

    const deviceCount = await tx.printerDevice.count({
      where: { machineId: discovery.machineId, windowsPrinterName: { not: null } }
    });
    if (deviceCount >= MAX_PRINTER_DEVICES_PER_MACHINE) {
      throw new AppError(`A Machine can have at most ${MAX_PRINTER_DEVICES_PER_MACHINE} approved physical printers.`, 409);
    }

    const device = await tx.printerDevice.create({
      data: {
        machineId: discovery.machineId,
        displayName,
        windowsPrinterName: discovery.windowsPrinterName,
        driverName: discovery.driverName,
        portName: discovery.portName,
        connectionType: discovery.connectionType,
        isDefault: discovery.isDefault,
        status: 'ACTIVE',
        healthStatus: 'UNKNOWN',
        sortOrder: deviceCount,
        approvedAt: new Date(),
        approvedBy: user.id || user.email,
        lastDiscoveredAt: discovery.lastSeenAt
      }
    });

    await tx.printerDiscovery.update({
      where: { id: discovery.id },
      data: { reviewStatus: 'APPROVED', approvedPrinterDeviceId: device.id }
    });
    await tx.activityLog.create({
      data: {
        action: 'PRINTER_DEVICE_APPROVED',
        details: JSON.stringify({
          printerDeviceId: device.id,
          discoveryId: discovery.id,
          windowsPrinterName: discovery.windowsPrinterName,
          displayName
        }),
        userId: user.id || null,
        machineId: discovery.machineId
      }
    });

    return { device, alreadyApproved: false };
  });
};

module.exports = {
  MAX_PRINTER_DEVICES_PER_MACHINE,
  DISCOVERY_MAX_AGE_MS,
  recordPrinterDiscoveryInventory,
  listPrinterDiscoveries,
  listApprovedPrinterDevices,
  approvePrinterDiscovery
};
