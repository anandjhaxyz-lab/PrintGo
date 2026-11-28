'use strict';

describe('PrintGo Discovery-Only Socket.IO integration', () => {
  const path = require('path');
  const fs = require('fs');

  let mockSocket;
  let mockListeners;
  let mockExecFile;
  let mockAxiosGet;
  let mockQueueEnqueue;
  let mockJournal;
  let mockWriteFileSync;
  let mockUnlinkSync;
  let agent;
  let originalEnv;
  let originalProcessListeners;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();

    originalEnv = {
      MACHINE_KEY: process.env.MACHINE_KEY,
      DISCOVERY_ONLY: process.env.DISCOVERY_ONLY,
      PRINTER_NAME: process.env.PRINTER_NAME
    };
    process.env.MACHINE_KEY = 'integration-test-machine-key';
    process.env.DISCOVERY_ONLY = 'true';
    delete process.env.PRINTER_NAME;

    mockListeners = new Map();
    mockSocket = {
      id: 'socket-integration-test',
      on: jest.fn((event, handler) => mockListeners.set(event, handler)),
      emit: jest.fn()
    };
    mockExecFile = jest.fn();
    mockAxiosGet = jest.fn();
    mockQueueEnqueue = jest.fn();
    mockJournal = { markerPath: 'integration-test-journal', isCorrupted: false, getJob: jest.fn(), recordReceived: jest.fn(), recordDispatchIntent: jest.fn(), recordSpoolerAccepted: jest.fn(), recordCompleted: jest.fn() };

    originalProcessListeners = {
      uncaughtException: process.listeners('uncaughtException'),
      unhandledRejection: process.listeners('unhandledRejection')
    };

    jest.doMock('dotenv', () => ({ config: jest.fn() }), { virtual: true });
    jest.doMock('socket.io-client', () => ({
      io: jest.fn(() => mockSocket)
    }), { virtual: true });
    jest.doMock('axios', () => ({
      get: mockAxiosGet,
      default: mockAxiosGet
    }), { virtual: true });
    jest.doMock('child_process', () => ({
      exec: jest.fn(),
      execFile: mockExecFile
    }));
    jest.doMock('node-forge', () => ({
      pki: {
        rsa: { generateKeyPair: jest.fn() },
        publicKeyToPem: jest.fn(),
        privateKeyToPem: jest.fn()
      }
    }), { virtual: true });
    jest.doMock('../src/journal', () => jest.fn().mockImplementation(() => mockJournal));
    jest.doMock('../src/spooler', () => jest.fn().mockImplementation(() => ({
      checkPrinterStatus: jest.fn(),
      startPollingJob: jest.fn()
    })));
    jest.doMock('../src/printerDeviceQueue', () => ({
      PrinterDeviceQueue: jest.fn().mockImplementation(() => ({
        enqueue: mockQueueEnqueue
      }))
    }));
    jest.doMock('../src/dispatchAuthorization', () => ({
      PrinterDispatchAuthorizer: jest.fn().mockImplementation(() => ({
        authorize: jest.fn(),
        startLeaseRenewal: jest.fn(),
        releaseLease: jest.fn()
      }))
    }));

    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
      if (filePath === path.join(__dirname, 'keys', 'public.pem') ||
          filePath === path.join(__dirname, 'keys', 'private.pem')) {
        return 'integration-test-key-material';
      }
      return originalReadFileSync(filePath, ...args);
    });

    mockWriteFileSync = jest.spyOn(fs, 'writeFileSync');
    mockUnlinkSync = jest.spyOn(fs, 'unlinkSync');

    agent = require('../index');
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();

    if (originalEnv.MACHINE_KEY === undefined) delete process.env.MACHINE_KEY;
    else process.env.MACHINE_KEY = originalEnv.MACHINE_KEY;
    if (originalEnv.DISCOVERY_ONLY === undefined) delete process.env.DISCOVERY_ONLY;
    else process.env.DISCOVERY_ONLY = originalEnv.DISCOVERY_ONLY;
    if (originalEnv.PRINTER_NAME === undefined) delete process.env.PRINTER_NAME;
    else process.env.PRINTER_NAME = originalEnv.PRINTER_NAME;

    for (const listener of process.listeners('uncaughtException')) {
      if (!originalProcessListeners.uncaughtException.includes(listener)) {
        process.removeListener('uncaughtException', listener);
      }
    }
    for (const listener of process.listeners('unhandledRejection')) {
      if (!originalProcessListeners.unhandledRejection.includes(listener)) {
        process.removeListener('unhandledRejection', listener);
      }
    }
    jest.resetModules();
  });

  function triggerSocketEvent(event, payload) {
    const handler = mockListeners.get(event);
    if (!handler) throw new Error('Socket event handler not registered: ' + event);
    return handler(payload);
  }

  test('connects through the real Socket.IO event registration and refuses physical jobs before queueing or I/O', async () => {
    expect(agent.discoveryModeConfig).toEqual(expect.objectContaining({
      isDiscoveryOnly: true,
      isValid: true
    }));

    // Exercise the actual connect callback installed by index.js.
    triggerSocketEvent('connect');

    expect(mockSocket.emit).toHaveBeenCalledWith('register_public_key', expect.objectContaining({
      publicKey: expect.stringContaining('BEGIN PUBLIC KEY')
    }));
    expect(mockSocket.emit).toHaveBeenCalledWith('printer_agent_hello', expect.any(Object));

    const job = {
      jobId: 'integration_physical_job_001',
      fileUrl: 'https://example.invalid/private-job.pdf',
      printerDeviceId: 'device-test-001',
      windowsPrinterName: 'EPSON L6460 Series'
    };

    // Dispatch through the registered Socket.IO event, not the helper wrapper.
    triggerSocketEvent('physical_print_job', job);
    await Promise.resolve();

    expect(mockSocket.emit).toHaveBeenCalledWith('print_spooler_error', expect.objectContaining({
      jobId: job.jobId,
      printerDeviceId: job.printerDeviceId,
      windowsPrinterName: job.windowsPrinterName,
      error: expect.stringContaining('STRICT DISCOVERY_ONLY')
    }));
    expect(mockQueueEnqueue).not.toHaveBeenCalled();
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockJournal.recordReceived).not.toHaveBeenCalled();
    expect(mockJournal.recordDispatchIntent).not.toHaveBeenCalled();
    expect(mockJournal.recordSpoolerAccepted).not.toHaveBeenCalled();
    expect(mockJournal.recordCompleted).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
    expect(mockSocket.emit.mock.calls.map(([event]) => event)).not.toContain('print_spooler_success');
    expect(mockSocket.emit.mock.calls.map(([event]) => event)).not.toContain('print_physical_success');
    expect(mockSocket.emit.mock.calls.map(([event]) => event)).not.toContain('print_physical_ambiguous');
  });

  test('defense-in-depth exported processor also refuses a job without download, journal, or spooler side effects', async () => {
    const job = {
      jobId: 'integration_direct_job_002',
      fileUrl: 'https://example.invalid/private-job.pdf'
    };

    await agent.processPhysicalPrintJob(job);

    expect(mockSocket.emit).toHaveBeenCalledWith('print_spooler_error', expect.objectContaining({
      jobId: job.jobId,
      error: expect.stringContaining('STRICT DISCOVERY_ONLY')
    }));
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockQueueEnqueue).not.toHaveBeenCalled();
    expect(mockJournal.recordReceived).not.toHaveBeenCalled();
    expect(mockJournal.recordDispatchIntent).not.toHaveBeenCalled();
    expect(mockJournal.recordSpoolerAccepted).not.toHaveBeenCalled();
    expect(mockJournal.recordCompleted).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  test('discovery-only validation skips local printer-driver validation', async () => {
    await expect(agent.validatePrinter()).resolves.toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
