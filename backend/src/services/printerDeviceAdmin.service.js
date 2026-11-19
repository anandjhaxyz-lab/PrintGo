const AppError = require('../utils/AppError');
const { DISPATCH_LEASE_TTL_MS } = require('./printerDeviceJobBinding.service');

const DISCOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MIN_OPERATOR_REASON_LENGTH = 10;

function requireAdmin(user) {
  if (!user || !['SUPERADMIN', 'FRANCHISEE'].includes(user.role)) {
    throw new AppError('Only an authorized Admin can manage physical printer devices.', 403);
  }
}

function validateReason(reason) {
  const normalized = typeof reason === 'string' ? reason.trim() : '';
  if (normalized.length < MIN_OPERATOR_REASON_LENGTH || normalized.length > 500) {
    throw new AppError('An operator reason of 10 to 500 characters is required.', 400);
  }
  return normalized;
}

async function lockMachineAndDevice(tx, machineId, printerDeviceId) {
  await tx.$queryRaw`SELECT "id" FROM "Machine" WHERE "id" = ${machineId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "PrinterDevice" WHERE "id" = ${printerDeviceId} FOR UPDATE`;
}

async function assertNoActiveDispatchLease(tx, printerDeviceId, now = new Date()) {
  const lease = await tx.printerDeviceDispatchLease.findUnique({
    where: { printerDeviceId }
  });
  if (lease && !lease.releasedAt && lease.expiresAt > now) {
    const error = new AppError(
      `This printer is currently submitting job ${lease.jobShortId}. Try again after the Agent releases its dispatch lease.`,
      409
    );
    error.code = 'DEVICE_DISPATCH_IN_PROGRESS';
    error.leaseExpiresAt = lease.expiresAt;
    throw error;
  }
}

async function verifyCompanyAccess(device, user) {
  if (user.role !== 'SUPERADMIN' && device.machine?.companyId !== user.companyId) {
    throw new AppError('Access denied: this printer belongs to another company.', 403);
  }
}

async function disablePrinterDevice(printerDeviceId, data = {}, user, prisma) {
  requireAdmin(user);
  const reason = validateReason(data.reason);

  return prisma.$transaction(async (tx) => {
    const reference = await tx.printerDevice.findUnique({
      where: { id: printerDeviceId },
      select: { machineId: true }
    });
    if (!reference) throw new AppError('Printer device not found.', 404);

    await lockMachineAndDevice(tx, reference.machineId, printerDeviceId);
    const device = await tx.printerDevice.findUnique({
      where: { id: printerDeviceId },
      include: { machine: { select: { id: true, name: true, companyId: true } } }
    });
    if (!device) throw new AppError('Printer device not found.', 404);
    await verifyCompanyAccess(device, user);
    await assertNoActiveDispatchLease(tx, printerDeviceId);

    if (device.status === 'DISABLED') {
      return { device, alreadyDisabled: true };
    }

    const updated = await tx.printerDevice.update({
      where: { id: printerDeviceId },
      data: { status: 'DISABLED', healthStatus: 'UNKNOWN' },
      include: { machine: { select: { id: true, name: true, companyId: true } } }
    });

    await tx.activityLog.create({
      data: {
        action: 'PRINTER_DEVICE_DISABLED',
        details: JSON.stringify({
          printerDeviceId,
          windowsPrinterName: device.windowsPrinterName,
          previousStatus: device.status,
          reason
        }),
        userId: user.id || null,
        machineId: device.machineId
      }
    });

    return { device: updated, alreadyDisabled: false };
  });
}

async function remapPrinterDevice(printerDeviceId, data = {}, user, prisma) {
  requireAdmin(user);
  const reason = validateReason(data.reason);
  const discoveryId = typeof data.discoveryId === 'string' ? data.discoveryId.trim() : '';
  if (!discoveryId || discoveryId.length > 128) {
    throw new AppError('A valid fresh Windows printer discovery is required for remapping.', 400);
  }

  return prisma.$transaction(async (tx) => {
    const discoveryReference = await tx.printerDiscovery.findUnique({
      where: { id: discoveryId },
      select: { machineId: true }
    });
    if (!discoveryReference) throw new AppError('Selected Windows printer discovery was not found.', 404);

    // Match the approval workflow lock order: Discovery -> Machine -> Device.
    await tx.$queryRaw`SELECT "id" FROM "PrinterDiscovery" WHERE "id" = ${discoveryId} FOR UPDATE`;
    await lockMachineAndDevice(tx, discoveryReference.machineId, printerDeviceId);

    const [device, discovery] = await Promise.all([
      tx.printerDevice.findUnique({
        where: { id: printerDeviceId },
        include: { machine: { select: { id: true, name: true, companyId: true } } }
      }),
      tx.printerDiscovery.findUnique({ where: { id: discoveryId } })
    ]);

    if (!device) throw new AppError('Printer device not found.', 404);
    if (!discovery) throw new AppError('Selected Windows printer discovery was not found.', 404);
    await verifyCompanyAccess(device, user);

    if (discovery.machineId !== device.machineId) {
      throw new AppError('A printer can only be remapped to a Windows queue discovered on the same Machine.', 409);
    }
    if (!['DISCOVERED', 'APPROVED'].includes(discovery.reviewStatus)) {
      throw new AppError('The selected Windows queue is not available for Admin remapping.', 409);
    }
    if (
      discovery.reviewStatus === 'APPROVED' &&
      discovery.approvedPrinterDeviceId &&
      discovery.approvedPrinterDeviceId !== device.id
    ) {
      throw new AppError('The selected Windows queue is already assigned to another physical printer.', 409);
    }

    const lastSeenAt = new Date(discovery.lastSeenAt).getTime();
    if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt > DISCOVERY_MAX_AGE_MS) {
      throw new AppError('The selected discovery is stale. Reconnect the Agent and refresh Windows inventory.', 409);
    }

    await assertNoActiveDispatchLease(tx, printerDeviceId);

    const mappedQueue = await tx.printerDevice.findFirst({
      where: {
        machineId: device.machineId,
        id: { not: device.id },
        windowsPrinterName: { equals: discovery.windowsPrinterName, mode: 'insensitive' }
      },
      select: { id: true, displayName: true }
    });
    if (mappedQueue) {
      throw new AppError('The selected Windows queue is already mapped to another PrinterDevice.', 409);
    }

    const previousQueueName = device.windowsPrinterName;
    const now = new Date();
    const updated = await tx.printerDevice.update({
      where: { id: device.id },
      data: {
        windowsPrinterName: discovery.windowsPrinterName,
        driverName: discovery.driverName,
        portName: discovery.portName,
        connectionType: discovery.connectionType,
        lastDiscoveredAt: discovery.lastSeenAt,
        approvedAt: now,
        approvedBy: user.id || user.email,
        healthStatus: 'UNKNOWN'
      },
      include: { machine: { select: { id: true, name: true, companyId: true } } }
    });

    await tx.printerDiscovery.updateMany({
      where: {
        machineId: device.machineId,
        approvedPrinterDeviceId: device.id,
        id: { not: discovery.id }
      },
      data: { reviewStatus: 'DISCOVERED', approvedPrinterDeviceId: null }
    });
    await tx.printerDiscovery.update({
      where: { id: discovery.id },
      data: { reviewStatus: 'APPROVED', approvedPrinterDeviceId: device.id }
    });

    await tx.activityLog.create({
      data: {
        action: 'PRINTER_DEVICE_REMAPPED',
        details: JSON.stringify({
          printerDeviceId: device.id,
          previousWindowsPrinterName: previousQueueName,
          windowsPrinterName: discovery.windowsPrinterName,
          displayName: device.displayName,
          reason
        }),
        userId: user.id || null,
        machineId: device.machineId
      }
    });

    return { device: updated, previousWindowsPrinterName: previousQueueName };
  });
}

module.exports = {
  MIN_OPERATOR_REASON_LENGTH,
  disablePrinterDevice,
  remapPrinterDevice
};
