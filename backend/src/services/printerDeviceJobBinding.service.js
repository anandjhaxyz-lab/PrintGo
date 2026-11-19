/**
 * Verify that an authenticated Agent outcome refers to the exact PrinterDevice
 * bound to the PrintJob. A legacy Machine-level job must not claim a child device.
 */
function verifyPrinterDeviceReport(job, report) {
  if (!job || !report || typeof report !== 'object') return false;

  const reportedDeviceId = report.printerDeviceId || null;
  const reportedQueueName = report.windowsPrinterName || null;

  if (job.printerDeviceId) {
    const expectedQueueName = job.printerDevice?.windowsPrinterName || null;
    return Boolean(
      expectedQueueName &&
      reportedDeviceId === job.printerDeviceId &&
      reportedQueueName === expectedQueueName
    );
  }

  return !reportedDeviceId && !reportedQueueName;
}

/**
 * Authorize a single device-bound job against the current database state. This
 * is deliberately called after Agent download/decryption and immediately before
 * durable dispatch intent + driver submission, so a stale registry snapshot
 * cannot carry a disabled/remapped device through a long preparation window.
 */
async function authorizePrinterDeviceDispatch({ socket, prisma, request = {} }) {
  if (socket?.userType !== 'printer' || !socket.machineId) {
    return { accepted: false, code: 'UNAUTHORIZED_AGENT' };
  }

  const requestId = typeof request.requestId === 'string' ? request.requestId : '';
  const respond = (allowed, code = null, job = null) => {
    if (requestId && /^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
      socket.emit('printer_device_dispatch_authorization_result', {
        requestId,
        allowed,
        ...(allowed ? {
          jobId: job.shortId,
          printerDeviceId: job.printerDeviceId,
          windowsPrinterName: job.printerDevice.windowsPrinterName,
          machineId: socket.machineId
        } : { code })
      });
    }
    return {
      accepted: allowed,
      ...(requestId ? { requestId } : {}),
      ...(!allowed && code ? { code } : {})
    };
  };

  const jobId = typeof request.jobId === 'string' ? request.jobId : '';
  const printerDeviceId = typeof request.printerDeviceId === 'string' ? request.printerDeviceId : '';
  const windowsPrinterName = typeof request.windowsPrinterName === 'string'
    ? request.windowsPrinterName.trim()
    : '';

  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(jobId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(printerDeviceId) ||
    !windowsPrinterName ||
    windowsPrinterName.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(windowsPrinterName)
  ) {
    return respond(false, 'INVALID_DISPATCH_REQUEST');
  }

  if (process.env.ENABLE_MULTI_PRINTER_DISPATCH !== 'true') {
    return respond(false, 'DISPATCH_FEATURE_DISABLED');
  }

  try {
    const job = await prisma.printJob.findUnique({
      where: { shortId: jobId },
      include: { printerDevice: true }
    });

    if (!job) return respond(false, 'JOB_NOT_FOUND');
    if (job.machineId !== socket.machineId) return respond(false, 'MACHINE_BINDING_MISMATCH');
    if (job.status !== 'PRINTING' || job.printerDeviceId !== printerDeviceId) {
      return respond(false, 'JOB_NOT_DISPATCHABLE');
    }

    const device = job.printerDevice;
    if (!device || device.id !== printerDeviceId || device.machineId !== socket.machineId) {
      return respond(false, 'DEVICE_MACHINE_MISMATCH');
    }
    if (device.status !== 'ACTIVE') return respond(false, 'DEVICE_NOT_ACTIVE');
    if (!device.approvedAt) return respond(false, 'DEVICE_NOT_APPROVED');
    if (
      typeof device.windowsPrinterName !== 'string' ||
      !device.windowsPrinterName.trim() ||
      device.windowsPrinterName !== windowsPrinterName
    ) {
      return respond(false, 'QUEUE_MAPPING_MISMATCH');
    }

    return respond(true, null, job);
  } catch (error) {
    return respond(false, 'AUTHORIZATION_UNAVAILABLE');
  }
}

module.exports = { verifyPrinterDeviceReport, authorizePrinterDeviceDispatch };
