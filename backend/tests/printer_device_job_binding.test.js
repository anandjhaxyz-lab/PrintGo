const { verifyPrinterDeviceReport } = require('../src/services/printerDeviceJobBinding.service');

describe('Agent PrintJob PrinterDevice binding validation', () => {
  const deviceJob = {
    shortId: 'JOBDEVICE01',
    printerDeviceId: 'device-123',
    printerWindowsQueueName: 'Epson L6460',
    printerDevice: { windowsPrinterName: 'Epson L6460' }
  };

  test('accepts an exact device ID and exact Windows queue name', () => {
    expect(verifyPrinterDeviceReport(deviceJob, {
      jobId: deviceJob.shortId,
      printerDeviceId: 'device-123',
      windowsPrinterName: 'Epson L6460'
    })).toBe(true);
  });

  test('rejects an Agent report for another PrinterDevice on the same Machine', () => {
    expect(verifyPrinterDeviceReport(deviceJob, {
      jobId: deviceJob.shortId,
      printerDeviceId: 'device-456',
      windowsPrinterName: 'HP LaserJet'
    })).toBe(false);
  });

  test('rejects a matching device ID with a different queue name', () => {
    expect(verifyPrinterDeviceReport(deviceJob, {
      jobId: deviceJob.shortId,
      printerDeviceId: 'device-123',
      windowsPrinterName: 'Epson L6460 (Copy 1)'
    })).toBe(false);
  });

  test('continues validating an in-flight job against its immutable queue snapshot after Admin remap', () => {
    const remappedDeviceJob = {
      ...deviceJob,
      printerWindowsQueueName: 'Epson L6460',
      printerDevice: { windowsPrinterName: 'Epson L6460 (Copy 1)' }
    };

    expect(verifyPrinterDeviceReport(remappedDeviceJob, {
      jobId: deviceJob.shortId,
      printerDeviceId: 'device-123',
      windowsPrinterName: 'Epson L6460'
    })).toBe(true);

    expect(verifyPrinterDeviceReport(remappedDeviceJob, {
      jobId: deviceJob.shortId,
      printerDeviceId: 'device-123',
      windowsPrinterName: 'Epson L6460 (Copy 1)'
    })).toBe(false);
  });

  test('fails closed when the immutable PrintJob queue snapshot is missing', () => {
    const noSnapshotJob = {
      ...deviceJob,
      printerWindowsQueueName: null,
      printerDevice: { windowsPrinterName: 'Epson L6460' }
    };
    expect(verifyPrinterDeviceReport(noSnapshotJob, {
      jobId: deviceJob.shortId,
      printerDeviceId: 'device-123',
      windowsPrinterName: 'Epson L6460'
    })).toBe(false);
  });

  test('rejects a missing or incomplete PrinterDevice binding', () => {
    expect(verifyPrinterDeviceReport(deviceJob, { jobId: deviceJob.shortId })).toBe(false);
    expect(verifyPrinterDeviceReport(deviceJob, {
      jobId: deviceJob.shortId,
      printerDeviceId: 'device-123'
    })).toBe(false);
  });

  test('accepts a legacy Machine-level job only when no PrinterDevice is reported', () => {
    const legacyJob = { shortId: 'LEGACY01', printerDeviceId: null, printerDevice: null };
    expect(verifyPrinterDeviceReport(legacyJob, { jobId: 'LEGACY01' })).toBe(true);
  });

  test('rejects a PrinterDevice claim for a legacy Machine-level job', () => {
    const legacyJob = { shortId: 'LEGACY01', printerDeviceId: null, printerDevice: null };
    expect(verifyPrinterDeviceReport(legacyJob, {
      jobId: 'LEGACY01',
      printerDeviceId: 'device-123',
      windowsPrinterName: 'Epson L6460'
    })).toBe(false);
  });

  test('fails closed when the database PrinterDevice queue mapping is missing', () => {
    expect(verifyPrinterDeviceReport({
      shortId: 'JOBDEVICE02',
      printerDeviceId: 'device-123',
      printerDevice: { windowsPrinterName: null }
    }, {
      jobId: 'JOBDEVICE02',
      printerDeviceId: 'device-123',
      windowsPrinterName: 'Epson L6460'
    })).toBe(false);
  });
});
