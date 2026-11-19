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

module.exports = { verifyPrinterDeviceReport };
