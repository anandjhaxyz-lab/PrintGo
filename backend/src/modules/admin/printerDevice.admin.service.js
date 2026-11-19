const prisma = require('../../utils/prisma');
const AppError = require('../../utils/AppError');
const printerQrService = require('../../services/printerQr.service');

const MAX_PRINTERS_PER_MACHINE = 10;

const normalizeQueueKey = (value) => String(value || '').trim().toLocaleLowerCase('en-US');

const verifyMachine = async (machineId, user) => {
  if (!machineId || typeof machineId !== 'string') {
    throw new AppError('Machine ID is required', 400);
  }
  return printerQrService.verifyMachineAccess(machineId, user);
};

const listPrinterDiscovery = async (machineId, user, query = {}) => {
  await verifyMachine(machineId, user);
  const includeAbsent = query.includeAbsent === 'true';
  return prisma.printerDiscovery.findMany({
    where: {
      machineId,
      ...(includeAbsent ? {} : { isPresent: true })
    },
    include: {
      printerDevice: {
        select: {
          id: true,
          displayName: true,
          windowsPrinterName: true,
          status: true,
          approvedAt: true,
          approvedBy: true
        }
      }
    },
    orderBy: [
      { isPresent: 'desc' },
      { lastSeenAt: 'desc' },
      { windowsPrinterName: 'asc' }
    ]
  });
};

const listPrinterDevices = async (machineId, user) => {
  await verifyMachine(machineId, user);
  return prisma.printerDevice.findMany({
    where: { machineId },
    include: {
      discovery: {
        select: {
          id: true,
          windowsPrinterName: true,
          isPresent: true,
          lastSeenAt: true,
          driverName: true,
          portName: true,
          connectionType: true
        }
      },
      _count: { select: { printerQrs: true, printJobs: true } }
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
  });
};

/**
 * Bind one currently observed Windows queue to a logical PrinterDevice.
 * Discovery itself never creates or mutates devices; this explicit Admin
 * action may fill the one unbound legacy placeholder or create a new child.
 * The resulting device is ALWAYS PENDING_APPROVAL.
 */
const bindDiscoveredPrinterDevice = async (machineId, data = {}, user) => {
  await verifyMachine(machineId, user);

  const discoveryId = typeof data.discoveryId === 'string' ? data.discoveryId.trim() : '';
  if (!discoveryId || discoveryId.length > 128) {
    throw new AppError('A valid discoveryId is required', 400);
  }

  const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (displayName.length > 120 || /[\u0000-\u001f\u007f]/.test(displayName)) {
    throw new AppError('displayName must be 120 characters or fewer and contain no control characters', 400);
  }

  const operatorId = user ? (user.id || user.email || 'ADMIN') : 'ADMIN';

  return prisma.$transaction(async (tx) => {
    // Serialize binds and inventory reports for the same Machine.
    const lockedMachine = await tx.$queryRawUnsafe(
      'SELECT "id" FROM "Machine" WHERE "id" = $1 FOR UPDATE',
      machineId
    );
    if (!lockedMachine || lockedMachine.length === 0) {
      throw new AppError('Machine not found', 404);
    }

    const discovery = await tx.printerDiscovery.findFirst({
      where: { id: discoveryId, machineId, isPresent: true }
    });
    if (!discovery) {
      throw new AppError('Printer queue was not found in the latest Agent discovery. Refresh inventory and try again.', 404);
    }

    if (!discovery.windowsPrinterName || !discovery.queueNameKey) {
      throw new AppError('Discovered queue does not contain a valid exact Windows queue name', 400);
    }

    if (discovery.printerDeviceId) {
      const existingBinding = await tx.printerDevice.findFirst({
        where: { id: discovery.printerDeviceId, machineId }
      });
      if (!existingBinding) {
        throw new AppError('Discovery record contains an invalid device binding. Manual review is required.', 409);
      }
      return { device: existingBinding, alreadyBound: true };
    }

    const duplicate = await tx.printerDevice.findFirst({
      where: {
        machineId,
        windowsPrinterName: { equals: discovery.windowsPrinterName, mode: 'insensitive' }
      }
    });
    if (duplicate) {
      throw new AppError('This Windows queue is already mapped to another PrinterDevice on this PC.', 409);
    }

    const queueBoundCount = await tx.printerDevice.count({
      where: { machineId, windowsPrinterName: { not: null } }
    });
    const placeholder = await tx.printerDevice.findFirst({
      where: {
        machineId,
        isDefault: true,
        status: 'DISCOVERY_REQUIRED',
        windowsPrinterName: null
      },
      orderBy: { createdAt: 'asc' }
    });

    if (!placeholder && queueBoundCount >= MAX_PRINTERS_PER_MACHINE) {
      throw new AppError(`This PC is limited to ${MAX_PRINTERS_PER_MACHINE} queue-bound printers.`, 409);
    }

    const deviceData = {
      displayName: displayName || discovery.windowsPrinterName,
      windowsPrinterName: discovery.windowsPrinterName,
      driverName: discovery.driverName,
      portName: discovery.portName,
      connectionType: discovery.connectionType,
      status: 'PENDING_APPROVAL',
      approvedAt: null,
      approvedBy: null,
      lastDiscoveredAt: discovery.lastSeenAt || new Date()
    };

    const device = placeholder
      ? await tx.printerDevice.update({
          where: { id: placeholder.id },
          data: deviceData
        })
      : await tx.printerDevice.create({
          data: {
            machineId,
            ...deviceData,
            isDefault: false,
            sortOrder: queueBoundCount
          }
        });

    const linkResult = await tx.printerDiscovery.updateMany({
      where: {
        id: discovery.id,
        machineId,
        isPresent: true,
        printerDeviceId: null
      },
      data: { printerDeviceId: device.id }
    });

    if (linkResult.count !== 1) {
      throw new AppError('Printer discovery was bound by another Admin action. Refresh and try again.', 409);
    }

    return { device, alreadyBound: false };
  }, { maxWait: 10000, timeout: 15000 });
};

/**
 * Explicitly approve a queue mapping. Approval is allowed only while the exact
 * queue remains in the latest persisted inventory for the same Machine.
 */
const approvePrinterDevice = async (printerDeviceId, user) => {
  if (!printerDeviceId || typeof printerDeviceId !== 'string') {
    throw new AppError('PrinterDevice ID is required', 400);
  }

  const initial = await prisma.printerDevice.findUnique({
    where: { id: printerDeviceId },
    select: { id: true, machineId: true }
  });
  if (!initial) throw new AppError('PrinterDevice not found', 404);
  await verifyMachine(initial.machineId, user);

  const operatorId = user ? (user.id || user.email || 'ADMIN') : 'ADMIN';

  return prisma.$transaction(async (tx) => {
    const lockedMachine = await tx.$queryRawUnsafe(
      'SELECT "id" FROM "Machine" WHERE "id" = $1 FOR UPDATE',
      initial.machineId
    );
    if (!lockedMachine || lockedMachine.length === 0) {
      throw new AppError('Machine not found', 404);
    }

    const device = await tx.printerDevice.findFirst({
      where: { id: printerDeviceId, machineId: initial.machineId }
    });
    if (!device) throw new AppError('PrinterDevice not found', 404);

    if (device.status === 'ACTIVE' && device.approvedAt) {
      return { device, alreadyApproved: true };
    }

    if (device.status !== 'PENDING_APPROVAL') {
      throw new AppError('Only a PENDING_APPROVAL PrinterDevice can be approved.', 409);
    }

    if (!device.windowsPrinterName) {
      throw new AppError('Cannot approve a PrinterDevice without an exact Windows queue mapping.', 409);
    }

    const currentDiscovery = await tx.printerDiscovery.findFirst({
      where: {
        machineId: device.machineId,
        printerDeviceId: device.id,
        isPresent: true,
        queueNameKey: normalizeQueueKey(device.windowsPrinterName)
      }
    });
    if (!currentDiscovery) {
      throw new AppError('The mapped Windows queue is not present in the latest Agent inventory. Approval is blocked.', 409);
    }

    const approvedAt = new Date();
    const updateResult = await tx.printerDevice.updateMany({
      where: {
        id: device.id,
        machineId: device.machineId,
        status: 'PENDING_APPROVAL',
        windowsPrinterName: device.windowsPrinterName,
        approvedAt: null
      },
      data: {
        status: 'ACTIVE',
        approvedAt,
        approvedBy: operatorId,
        lastDiscoveredAt: currentDiscovery.lastSeenAt
      }
    });
    if (updateResult.count !== 1) {
      throw new AppError('PrinterDevice approval state changed concurrently. Refresh and try again.', 409);
    }

    const approvedDevice = await tx.printerDevice.findUnique({ where: { id: device.id } });
    return { device: approvedDevice, alreadyApproved: false };
  }, { maxWait: 10000, timeout: 15000 });
};

module.exports = {
  MAX_PRINTERS_PER_MACHINE,
  normalizeQueueKey,
  listPrinterDiscovery,
  listPrinterDevices,
  bindDiscoveredPrinterDevice,
  approvePrinterDevice
};
