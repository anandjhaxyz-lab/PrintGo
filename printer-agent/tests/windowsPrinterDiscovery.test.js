const {
  WINDOWS_PRINTER_DISCOVERY_SCRIPT,
  discoverWindowsPrinters,
  parseDiscoveryOutput
} = require('../src/windowsPrinterDiscovery');

describe('Windows printer discovery', () => {
  test('invokes a fixed PowerShell query without interpolating queue names', async () => {
    const execFile = jest.fn((command, args, options, callback) => {
      callback(null, JSON.stringify({
        Name: 'Epson L6460',
        DriverName: 'Epson ESC/P-R V4',
        PortName: 'USB001',
        PrinterStatus: 3,
        DetectedErrorState: 0,
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
    expect(args[5]).not.toContain('Epson L6460');
    expect(options).toEqual(expect.objectContaining({ timeout: 15000, windowsHide: true }));
    expect(printers).toEqual([expect.objectContaining({
      windowsPrinterName: 'Epson L6460',
      driverName: 'Epson ESC/P-R V4',
      portName: 'USB001',
      connectionType: 'USB',
      isDefault: true,
      workOffline: false
    })]);
  });

  test('normalizes a one-record JSON response and handles an empty inventory', () => {
    expect(parseDiscoveryOutput('{"Name":"Office Printer","PortName":"IP_192.168.1.20"}')).toEqual([
      expect.objectContaining({
        windowsPrinterName: 'Office Printer',
        connectionType: 'Network'
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
