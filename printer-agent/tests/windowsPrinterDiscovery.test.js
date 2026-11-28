const {
  WINDOWS_PRINTER_DISCOVERY_SCRIPT,
  discoverWindowsPrinters,
  parseDiscoveryOutput
} = require('../src/windowsPrinterDiscovery');

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
    expect(options).toEqual(expect.objectContaining({ timeout: 15000, windowsHide: true }));

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
});
