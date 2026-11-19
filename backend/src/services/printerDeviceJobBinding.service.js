const DISPATCH_LEASE_TTL_MS = 2 * 60 * 1000;

/**
 * Verify that an authenticated Agent outcome refers to the exact PrinterDevice
 * bound to the PrintJob. A legacy Machine-level job must not claim a child device.
 */
function verifyPrinterDeviceReport(job, report) {
  if (!job || !report || typeof report !== 'object') return false;

  const reportedDeviceId = report.printerDeviceId || null;
  const reportedQueueName = report.windowsPrinterName || null;

  if (job.printerDeviceId) {
    // The PrintJob queue snapshot is immutable; the PrinterDevice's current
    // mapping may have changed after this job was already dispatched.
    const expectedQueueName = job.printerWindowsQueueName || null;
    return Boolean(
      expectedQueueName &&
      reportedDeviceId === job.printerDeviceId &&
      reportedQueueName === expectedQueueName
    );
  }

  return !reportedDeviceId && !reportedQueueName;
}

function lockPrinterDevice(tx, printerDeviceId) {
  // Both lease acquisition and Admin mutations lock this same row first.
  // PostgreSQL therefore serializes authorization against disable/remap.
  return tx.$queryRaw`SELECT "id" FROM "PrinterDevice" WHERE "id" = ${printerDeviceId} FOR UPDATE`;
}

function validDispatchIdentity(request = {}) {
  const requestId = typeof request.requestId === 'string' ? request.requestId : '';
  const jobId = typeof request.jobId === 'string' ? request.jobId : '';
  const printerDeviceId = typeof request.printerDeviceId === 'string' ? request.printerDeviceId : '';
  const windowsPrinterName = typeof request.windowsPrinterName === 'string'
    ? request.windowsPrinterName.trim()
    : '';

  return {
    requestId,
    jobId,
    printerDeviceId,
    windowsPrinterName,
    valid: (
      /^[A-Za-z0-9_-]{1,128}$/.test(requestId) &&
      /^[A-Za-z0-9_-]{1,128}$/.test(jobId) &&
      /^[A-Za-z0-9_-]{1,128}$/.test(printerDeviceId) &&
      !!windowsPrinterName &&
      windowsPrinterName.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(windowsPrinterName)
    )
  };
}

async function authorizePrinterDeviceDispatch({ socket, prisma, request = {} }) {
  if (socket?.userType !== 'printer' || !socket.machineId) {
    return { accepted: false, code: 'UNAUTHORIZED_AGENT' };
  }

  const identity = validDispatchIdentity(request);
  const { requestId, jobId, printerDeviceId, windowsPrinterName } = identity;
  const respond = (allowed, code = null, job = null) => {
    socket.emit('printer_device_dispatch_authorization_result', {
      requestId,
      allowed,
      ...(allowed ? {
        jobId: job.shortId,
        printerDeviceId: job.printerDeviceId,
        windowsPrinterName: job.printerWindowsQueueName,
        machineId: socket.machineId,
        leaseExpiresAt: job.leaseExpiresAt
      } : { code })
    });
    return {
      accepted: allowed,
      requestId,
      ...(!allowed && code ? { code } : {})
    };
  };

  if (!identity.valid) {
    if (/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) return respond(false, 'INVALID_DISPATCH_REQUEST');
    return { accepted: false, code: 'INVALID_DISPATCH_REQUEST' };
  }

  if (process.env.ENABLE_MULTI_PRINTER_DISPATCH !== 'true') {
    return respond(false, 'DISPATCH_FEATURE_DISABLED');
  }

  try {
    const decision = await prisma.$transaction(async (tx) => {
      await lockPrinterDevice(tx, printerDeviceId);

      const job = await tx.printJob.findUnique({
        where: { shortId: jobId },
        include: { printerDevice: true }
      });

      if (!job) return { allowed: false, code: 'JOB_NOT_FOUND' };
      if (job.machineId !== socket.machineId) return { allowed: false, code: 'MACHINE_BINDING_MISMATCH' };
      if (job.status !== 'PRINTING' || job.printerDeviceId !== printerDeviceId) {
        return { allowed: false, code: 'JOB_NOT_DISPATCHABLE' };
      }

      const device = job.printerDevice;
      if (!device || device.id !== printerDeviceId || device.machineId !== socket.machineId) {
        return { allowed: false, code: 'DEVICE_MACHINE_MISMATCH' };
      }
      if (device.status !== 'ACTIVE') return { allowed: false, code: 'DEVICE_NOT_ACTIVE' };
      if (!device.approvedAt) return { allowed: false, code: 'DEVICE_NOT_APPROVED' };
      if (
        typeof job.printerWindowsQueueName !== 'string' ||
        !job.printerWindowsQueueName.trim() ||
        job.printerWindowsQueueName !== windowsPrinterName
      ) {
        return { allowed: false, code: 'JOB_QUEUE_SNAPSHOT_MISMATCH' };
      }
      // An Admin remap before Agent authorization must block the old queued
      // job. A remap after the authorization/driver handoff does not rewrite
      // the job's immutable queue snapshot used for later outcome reports.
      if (
        typeof device.windowsPrinterName !== 'string' ||
        !device.windowsPrinterName.trim() ||
        device.windowsPrinterName !== job.printerWindowsQueueName
      ) {
        return { allowed: false, code: 'QUEUE_MAPPING_MISMATCH' };
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + DISPATCH_LEASE_TTL_MS);
      const existingLease = await tx.printerDeviceDispatchLease.findUnique({
        where: { printerDeviceId }
      });
      const isActiveLease = Boolean(
        existingLease &&
        !existingLease.releasedAt &&
        existingLease.expiresAt > now
      );
      if (isActiveLease && (
        existingLease.requestId !== requestId ||
        existingLease.jobShortId !== jobId
      )) {
        return {
          allowed: false,
          code: 'DEVICE_DISPATCH_IN_PROGRESS',
          leaseExpiresAt: existingLease.expiresAt
        };
      }

      await tx.printerDeviceDispatchLease.upsert({
        where: { printerDeviceId },
        create: {
          printerDeviceId,
          requestId,
          jobShortId: jobId,
          expiresAt,
          releasedAt: null
        },
        update: {
          requestId,
          jobShortId: jobId,
          expiresAt,
          releasedAt: null
        }
      });

      return { allowed: true, job, leaseExpiresAt: expiresAt };
    });

    if (!decision.allowed) {
      return respond(false, decision.code);
    }
    return respond(true, null, {
      ...decision.job,
      leaseExpiresAt: decision.leaseExpiresAt
    });
  } catch (error) {
    return respond(false, 'AUTHORIZATION_UNAVAILABLE');
  }
}

async function renewPrinterDeviceDispatchLease({ socket, prisma, request = {} }) {
  if (socket?.userType !== 'printer' || !socket.machineId) {
    return { renewed: false, code: 'UNAUTHORIZED_AGENT' };
  }
  const identity = validDispatchIdentity(request);
  if (!identity.valid) return { renewed: false, code: 'INVALID_DISPATCH_REQUEST' };

  try {
    return await prisma.$transaction(async (tx) => {
      await lockPrinterDevice(tx, identity.printerDeviceId);
      const lease = await tx.printerDeviceDispatchLease.findUnique({
        where: { printerDeviceId: identity.printerDeviceId },
        include: { printerDevice: { select: { machineId: true } } }
      });
      const now = new Date();
      if (
        !lease ||
        lease.requestId !== identity.requestId ||
        lease.jobShortId !== identity.jobId ||
        lease.releasedAt ||
        lease.expiresAt <= now ||
        lease.printerDevice?.machineId !== socket.machineId
      ) {
        return { renewed: false, code: 'DISPATCH_LEASE_NOT_ACTIVE' };
      }

      const expiresAt = new Date(now.getTime() + DISPATCH_LEASE_TTL_MS);
      const updated = await tx.printerDeviceDispatchLease.updateMany({
        where: {
          printerDeviceId: identity.printerDeviceId,
          requestId: identity.requestId,
          jobShortId: identity.jobId,
          releasedAt: null,
          expiresAt: { gt: now }
        },
        data: { expiresAt }
      });
      return updated.count === 1
        ? { renewed: true, requestId: identity.requestId, expiresAt }
        : { renewed: false, code: 'DISPATCH_LEASE_NOT_ACTIVE' };
    });
  } catch (error) {
    return { renewed: false, code: 'DISPATCH_LEASE_RENEWAL_UNAVAILABLE' };
  }
}

async function releasePrinterDeviceDispatchLease({ socket, prisma, request = {} }) {
  if (socket?.userType !== 'printer' || !socket.machineId) {
    return { released: false, code: 'UNAUTHORIZED_AGENT' };
  }
  const identity = validDispatchIdentity(request);
  if (!identity.valid) return { released: false, code: 'INVALID_DISPATCH_REQUEST' };

  try {
    return await prisma.$transaction(async (tx) => {
      await lockPrinterDevice(tx, identity.printerDeviceId);
      const lease = await tx.printerDeviceDispatchLease.findUnique({
        where: { printerDeviceId: identity.printerDeviceId },
        include: { printerDevice: { select: { machineId: true } } }
      });
      if (
        !lease ||
        lease.requestId !== identity.requestId ||
        lease.jobShortId !== identity.jobId ||
        lease.releasedAt ||
        lease.printerDevice?.machineId !== socket.machineId
      ) {
        return { released: false, code: 'DISPATCH_LEASE_NOT_ACTIVE' };
      }

      const releasedAt = new Date();
      const updated = await tx.printerDeviceDispatchLease.updateMany({
        where: {
          printerDeviceId: identity.printerDeviceId,
          requestId: identity.requestId,
          jobShortId: identity.jobId,
          releasedAt: null
        },
        data: { releasedAt }
      });
      return updated.count === 1
        ? { released: true, requestId: identity.requestId }
        : { released: false, code: 'DISPATCH_LEASE_NOT_ACTIVE' };
    });
  } catch (error) {
    return { released: false, code: 'DISPATCH_LEASE_RELEASE_UNAVAILABLE' };
  }
}

module.exports = {
  DISPATCH_LEASE_TTL_MS,
  verifyPrinterDeviceReport,
  authorizePrinterDeviceDispatch,
  renewPrinterDeviceDispatchLease,
  releasePrinterDeviceDispatchLease
};
