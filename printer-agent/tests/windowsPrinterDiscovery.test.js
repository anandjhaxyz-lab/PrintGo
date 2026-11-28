const {
  WINDOWS_PRINTER_DISCOVERY_SCRIPT,
  MIN_DISCOVERY_TIMEOUT_MS,
  MAX_DISCOVERY_TIMEOUT_MS,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  normalizeDiscoveryTimeoutMs,
  discoverWindowsPrinters,
  parseDiscoveryOutput
} = require('../src/windowsPrinterDiscovery');
const { PrinterFleetManager } = require('../src/printerFleetManager');
const { evaluatePrintJobSafety, parseDiscoveryModeConfig } = require('../src/discoveryMode');

describe('Windows printer discovery', () => {
  test('invokes a fixed PowerShell query selecting both Extended telemetry fields', async () => {
    const execFile = jest.fn((command, args, options, callback) => {
      callback(null, JSON.stringify({
        Name: 'EPSON L6460 Series',
        DriverName: 'EPSON L6460 Series',
        PortName: '192.168.1.7',
        PrinterStatus: 3,
        ExtendedPrinterStatus: 2,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: 0,
        WorkOffline: false,
        Shared: false,
        Network: false,
        Default: true
      }));
    });

    const printers = await discoverWindowsPrinters({ platform: 'win32', execFile });

    expect(execFile).toHaveBeenCalledTimes(1);
    const [command, args, options] = execFile.mock.calls[0];
    expect(command).toBe('powershell.exe');
    expect(args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    expect(args[4]).toBe('-Command');
    expect(args[5]).toBe(WINDOWS_PRINTER_DISCOVERY_SCRIPT);
    expect(args[5]).toContain('Get-CimInstance -ClassName Win32_Printer');
    expect(args[5]).toContain('ExtendedPrinterStatus');
    expect(args[5]).toContain('ExtendedDetectedErrorState');
    expect(args[5]).not.toContain('EPSON L6460 Series');
    expect(options).toEqual(expect.objectContaining({ timeout: 30000, windowsHide: true }));

    expect(printers).toEqual([expect.objectContaining({
      windowsPrinterName: 'EPSON L6460 Series',
      driverName: 'EPSON L6460 Series',
      portName: '192.168.1.7',
      connectionType: 'Network',
      printerStatus: 3,
      extendedPrinterStatus: 2,
      detectedErrorState: 0,
      extendedDetectedErrorState: 0,
      workOffline: false,
      isDefault: true
    })]);
  });

  test('correctly preserves Extended fields for array of real Windows printer shapes (Epson, HP, Canon)', () => {
    const rawInventory = JSON.stringify([
      {
        Name: 'EPSON L6460 Series',
        DriverName: 'EPSON L6460 Series',
        PortName: '192.168.1.7',
        PrinterStatus: 3,
        ExtendedPrinterStatus: 2,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: 0,
        WorkOffline: false,
        Default: true
      },
      {
        Name: 'HP LaserJet Professional M1136 MFP (Copy 1)',
        DriverName: 'HP LaserJet Professional M1136 MFP',
        PortName: 'USB011',
        PrinterStatus: 3,
        ExtendedPrinterStatus: 2,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: 0,
        WorkOffline: false,
        Default: false
      },
      {
        Name: 'Canon Generic Plus UFR II (Copy 2)',
        DriverName: 'Canon Generic Plus UFR II',
        PortName: 'USB001',
        PrinterStatus: 3,
        ExtendedPrinterStatus: 2,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: 0,
        WorkOffline: false,
        Default: false
      }
    ]);

    const result = parseDiscoveryOutput(rawInventory);
    expect(result).toHaveLength(3);

    expect(result[0]).toEqual(expect.objectContaining({
      windowsPrinterName: 'EPSON L6460 Series',
      connectionType: 'Network',
      printerStatus: 3,
      extendedPrinterStatus: 2,
      detectedErrorState: 0,
      extendedDetectedErrorState: 0,
      workOffline: false
    }));

    expect(result[1]).toEqual(expect.objectContaining({
      windowsPrinterName: 'HP LaserJet Professional M1136 MFP (Copy 1)',
      connectionType: 'USB',
      printerStatus: 3,
      extendedPrinterStatus: 2,
      detectedErrorState: 0,
      extendedDetectedErrorState: 0,
      workOffline: false
    }));

    expect(result[2]).toEqual(expect.objectContaining({
      windowsPrinterName: 'Canon Generic Plus UFR II (Copy 2)',
      connectionType: 'USB',
      printerStatus: 3,
      extendedPrinterStatus: 2,
      detectedErrorState: 0,
      extendedDetectedErrorState: 0,
      workOffline: false
    }));
  });

  test('handles missing or null Extended fields by defaulting safely to null', () => {
    const rawWithoutExtended = JSON.stringify({
      Name: 'Legacy Queue',
      PortName: 'USB001',
      PrinterStatus: 3,
      DetectedErrorState: 2,
      WorkOffline: false
    });

    const [normalized] = parseDiscoveryOutput(rawWithoutExtended);
    expect(normalized.windowsPrinterName).toBe('Legacy Queue');
    expect(normalized.extendedPrinterStatus).toBeNull();
    expect(normalized.extendedDetectedErrorState).toBeNull();
  });

  test('normalizes a one-record JSON response and handles an empty inventory', () => {
    expect(parseDiscoveryOutput('{"Name":"Office Printer","PortName":"IP_192.168.1.20"}')).toEqual([
      expect.objectContaining({
        windowsPrinterName: 'Office Printer',
        connectionType: 'Network',
        extendedPrinterStatus: null,
        extendedDetectedErrorState: null
      })
    ]);
    expect(parseDiscoveryOutput('')).toEqual([]);
    expect(parseDiscoveryOutput('[]')).toEqual([]);
  });

  test('rejects duplicate queue names case-insensitively', () => {
    expect(() => parseDiscoveryOutput(JSON.stringify([
      { Name: 'Epson L6460', PortName: 'USB001' },
      { Name: 'epson l6460', PortName: 'USB002' }
    ]))).toThrow(expect.objectContaining({ code: 'DUPLICATE_PRINTER_QUEUE' }));
  });

  test('rejects malformed or nameless printer records instead of silently dropping them', () => {
    expect(() => parseDiscoveryOutput('{not-json')).toThrow(
      expect.objectContaining({ code: 'INVALID_DISCOVERY_OUTPUT' })
    );
    expect(() => parseDiscoveryOutput(JSON.stringify({ DriverName: 'Missing Name' }))).toThrow(
      expect.objectContaining({ code: 'INVALID_PRINTER_RECORD' })
    );
  });

  test('fails closed on non-Windows platforms', async () => {
    await expect(discoverWindowsPrinters({
      platform: 'linux',
      execFile: jest.fn()
    })).rejects.toEqual(expect.objectContaining({ code: 'UNSUPPORTED_PLATFORM' }));
  });

  test('surfaces PowerShell failures without returning a partial inventory', async () => {
    const execFile = jest.fn((command, args, options, callback) => {
      callback(new Error('access denied'), '', 'access denied');
    });

    await expect(discoverWindowsPrinters({ platform: 'win32', execFile }))
      .rejects.toEqual(expect.objectContaining({ code: 'WINDOWS_DISCOVERY_FAILED' }));
  });

  test('default discovery timeout is 30000 ms and exportable', async () => {
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(30000);

    const execFile = jest.fn((command, args, options, callback) => {
      callback(null, '[]');
    });

    await discoverWindowsPrinters({ platform: 'win32', execFile });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [, , options] = execFile.mock.calls[0];
    expect(options.timeout).toBe(30000);
  });

  test('honors explicit discovery timeout override', async () => {
    const execFile = jest.fn((command, args, options, callback) => {
      callback(null, '[]');
    });

    await discoverWindowsPrinters({ platform: 'win32', execFile, timeoutMs: 45000 });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [, , options] = execFile.mock.calls[0];
    expect(options.timeout).toBe(45000);
  });

  test('timeout produces a controlled discovery failure and cleans up child process', async () => {
    const mockKill = jest.fn();
    const execFile = jest.fn((command, args, options, callback) => {
      const child = { killed: false, kill: mockKill };
      process.nextTick(() => {
        const err = new Error('Command timed out');
        err.killed = true;
        err.signal = 'SIGTERM';
        err.code = 'ETIMEDOUT';
        callback(err, '', '');
      });
      return child;
    });

    await expect(discoverWindowsPrinters({ platform: 'win32', execFile, timeoutMs: 30000 }))
      .rejects.toEqual(expect.objectContaining({
        code: 'WINDOWS_DISCOVERY_FAILED',
        message: expect.stringContaining('timed out after 30000ms')
      }));

    expect(mockKill).toHaveBeenCalledWith('SIGKILL');
  });

  test('coalesces concurrent discovery operations into a single execution', async () => {
    let callCount = 0;
    const execFile = jest.fn((command, args, options, callback) => {
      callCount++;
      setTimeout(() => {
        callback(null, JSON.stringify([{ Name: 'Epson L6460 Series', PortName: '192.168.1.7' }]));
      }, 20);
    });

    const [res1, res2] = await Promise.all([
      discoverWindowsPrinters({ platform: 'win32', execFile }),
      discoverWindowsPrinters({ platform: 'win32', execFile })
    ]);

    expect(callCount).toBe(1);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(res1).toHaveLength(1);
    expect(res2).toHaveLength(1);
    expect(res1[0].windowsPrinterName).toBe('Epson L6460 Series');
    expect(res2[0].windowsPrinterName).toBe('Epson L6460 Series');
  });

  test('sequential retry: failure cleans up state and allows subsequent fresh execution to succeed', async () => {
    let callCount = 0;
    const mockKill = jest.fn();
    const execFile = jest.fn((command, args, options, callback) => {
      callCount++;
      if (callCount === 1) {
        const child = { killed: false, kill: mockKill };
        process.nextTick(() => {
          const err = new Error('Discovery timed out');
          err.killed = true;
          err.signal = 'SIGTERM';
          err.code = 'ETIMEDOUT';
          callback(err, '', '');
        });
        return child;
      }
      process.nextTick(() => {
        callback(null, JSON.stringify([{ Name: 'Canon Generic Plus UFR II (Copy 2)', PortName: 'USB001' }]));
      });
      return { killed: false, kill: jest.fn() };
    });

    // 1. First discovery call times out and rejects
    await expect(discoverWindowsPrinters({ platform: 'win32', execFile }))
      .rejects.toEqual(expect.objectContaining({
        code: 'WINDOWS_DISCOVERY_FAILED',
        message: expect.stringContaining('timed out after 30000ms')
      }));

    expect(callCount).toBe(1);
    expect(mockKill).toHaveBeenCalledWith('SIGKILL');

    // 2. Second discovery call executes a fresh subprocess and succeeds (no stale promise or deadlock)
    const retryResult = await discoverWindowsPrinters({ platform: 'win32', execFile });
    expect(callCount).toBe(2);
    expect(retryResult).toHaveLength(1);
    expect(retryResult[0].windowsPrinterName).toBe('Canon Generic Plus UFR II (Copy 2)');
  });

  test('validates discovery timeout boundaries and handles invalid/extreme values safely', () => {
    expect(MIN_DISCOVERY_TIMEOUT_MS).toBe(1000);
    expect(MAX_DISCOVERY_TIMEOUT_MS).toBe(300000);
    expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(30000);

    // Valid inputs
    expect(normalizeDiscoveryTimeoutMs('1000')).toBe(1000);
    expect(normalizeDiscoveryTimeoutMs('15000')).toBe(15000);
    expect(normalizeDiscoveryTimeoutMs('300000')).toBe(300000);
    expect(normalizeDiscoveryTimeoutMs(1000)).toBe(1000);
    expect(normalizeDiscoveryTimeoutMs(15000)).toBe(15000);
    expect(normalizeDiscoveryTimeoutMs(300000)).toBe(300000);

    // Invalid string inputs — strict full-string validation
    expect(normalizeDiscoveryTimeoutMs('1500.5')).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs('1000abc')).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs('abc1000')).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs('1e4')).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs('')).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs(' ')).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs('   ')).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs('0')).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs('-1000')).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs('999999999999')).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs('not-a-number')).toBe(30000);

    // Invalid numeric and non-integer inputs
    expect(normalizeDiscoveryTimeoutMs(1500.5)).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs(NaN)).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs(Infinity)).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs(-Infinity)).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs(0)).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs(-1000)).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs(500)).toBe(30000); // below minimum
    expect(normalizeDiscoveryTimeoutMs(300001)).toBe(30000); // above maximum
    expect(normalizeDiscoveryTimeoutMs(999999999999)).toBe(30000); // 32-bit overflow
    expect(normalizeDiscoveryTimeoutMs(undefined)).toBe(30000);
    expect(normalizeDiscoveryTimeoutMs(null)).toBe(30000);
  });

  test('failed discovery does not initialize an invalid printer fleet', async () => {
    const monitorFactory = jest.fn(() => ({ checkPrinterStatus: jest.fn() }));
    const manager = new PrinterFleetManager({
      maxDevices: 10,
      discoverPrinters: async () => {
        throw new Error('Windows printer discovery timed out after 30000ms.');
      },
      getDeviceRegistry: async () => [
        {
          id: 'dev-1',
          windowsPrinterName: 'Epson L6460 Series',
          status: 'ACTIVE',
          approvedAt: '2026-11-20T00:00:00.000Z'
        }
      ],
      monitorFactory
    });

    await expect(manager.refresh()).rejects.toThrow('Windows printer discovery timed out after 30000ms.');
    expect(monitorFactory).not.toHaveBeenCalled();
    expect(manager.getMonitor('dev-1')).toBeNull();
    expect(() => manager.resolveForPrint('dev-1')).toThrow(
      expect.objectContaining({ code: 'PRINTER_DEVICE_NOT_APPROVED_OR_AVAILABLE' })
    );
  });

  test('strict discovery-only guard blocks physical and simulated printing even if discovery fails or succeeds', () => {
    const config = parseDiscoveryModeConfig({ DISCOVERY_ONLY: 'true' });
    expect(config.isDiscoveryOnly).toBe(true);

    const safetyCheckPhys = evaluatePrintJobSafety({ jobId: 'job-1', simulatePrint: false }, config);
    expect(safetyCheckPhys.blocked).toBe(true);
    expect(safetyCheckPhys.reason).toContain('STRICT DISCOVERY_ONLY mode');

    const safetyCheckSim = evaluatePrintJobSafety({ jobId: 'job-2', simulatePrint: true }, config);
    expect(safetyCheckSim.blocked).toBe(true);
    expect(safetyCheckSim.reason).toContain('STRICT DISCOVERY_ONLY mode');
  });

  test('existing independent SpoolerMonitor behavior remains intact for distinct devices', async () => {
    const monitorFactory = jest.fn(({ printerName, printerDeviceId }) => ({
      printerName,
      printerDeviceId,
      checkPrinterStatus: jest.fn()
    }));

    const manager = new PrinterFleetManager({
      maxDevices: 10,
      discoverPrinters: async () => [
        { windowsPrinterName: 'Epson L6460 Series', portName: '192.168.1.7' },
        { windowsPrinterName: 'HP LaserJet Professional M1136 MFP (Copy 1)', portName: 'USB011' },
        { windowsPrinterName: 'Canon Generic Plus UFR II (Copy 2)', portName: 'USB001' }
      ],
      getDeviceRegistry: async () => [
        { id: 'epson-id', windowsPrinterName: 'Epson L6460 Series', status: 'ACTIVE', approvedAt: '2026-11-20T00:00:00.000Z' },
        { id: 'hp-id', windowsPrinterName: 'HP LaserJet Professional M1136 MFP (Copy 1)', status: 'ACTIVE', approvedAt: '2026-11-20T00:00:00.000Z' },
        { id: 'canon-id', windowsPrinterName: 'Canon Generic Plus UFR II (Copy 2)', status: 'ACTIVE', approvedAt: '2026-11-20T00:00:00.000Z' }
      ],
      monitorFactory
    });

    const activeDevices = await manager.refresh();
    expect(activeDevices).toHaveLength(3);
    expect(monitorFactory).toHaveBeenCalledTimes(3);

    const epsonMon = manager.getMonitor('epson-id');
    const hpMon = manager.getMonitor('hp-id');
    const canonMon = manager.getMonitor('canon-id');

    expect(epsonMon).toBeDefined();
    expect(hpMon).toBeDefined();
    expect(canonMon).toBeDefined();

    expect(epsonMon).not.toBe(hpMon);
    expect(hpMon).not.toBe(canonMon);
    expect(epsonMon).not.toBe(canonMon);
  });
});
