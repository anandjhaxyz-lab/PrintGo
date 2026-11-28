const fs = require('fs');
const SpoolerMonitor = require('../src/spooler');

jest.mock('fs');
jest.useFakeTimers();

describe('PowerShell command encoding', () => {
  test('encodes Windows queue names instead of interpolating them into script source', () => {
    const queueName = "Office Printer 'Primary'; Write-Error injected";
    const encoded = Buffer.from(queueName, 'utf16le').toString('base64');
    const script = SpoolerMonitor.buildPrinterStatusCommand(queueName);

    expect(script).toContain(`FromBase64String('${encoded}')`);
    expect(script).not.toContain(queueName);
    expect(script).toContain('$printerName');
    expect(script).toContain('$escapedPrinterName');
    expect(script).toContain('-Filter $filter');
    expect(script).not.toContain('Where-Object { $_.Name -eq $printerName }');
  });

  test('builds robust, safely escaped WQL filter commands for diverse queue names', () => {
    const testCases = [
      { name: 'Epson L6460 Series', expectedWqlValue: "Name = 'Epson L6460 Series'" },
      { name: 'Canon Generic Plus UFR II (Copy 2)', expectedWqlValue: "Name = 'Canon Generic Plus UFR II (Copy 2)'" },
      { name: 'HP LaserJet Professional M1136 MFP (Copy 1)', expectedWqlValue: "Name = 'HP LaserJet Professional M1136 MFP (Copy 1)'" },
      { name: "Bob's Printer", expectedWqlValue: "Name = 'Bob\\'s Printer'" },
      { name: 'Server\\Printer', expectedWqlValue: "Name = 'Server\\\\Printer'" },
      { name: "Server\\Bob's Printer", expectedWqlValue: "Name = 'Server\\\\Bob\\'s Printer'" },
      { name: 'Printer "Office" \'Front\' $(calc.exe) ; Write-Error injected', expectedWqlValue: "Name = 'Printer \"Office\" \\'Front\\' $(calc.exe) ; Write-Error injected'" }
    ];

    for (const { name, expectedWqlValue } of testCases) {
      const script = SpoolerMonitor.buildPrinterStatusCommand(name);

      // Raw queue name never appears in generated script
      expect(script).not.toContain(name);

      // Base64 encoding cleanly round-trips to the original input
      const b64Match = script.match(/FromBase64String\('([^']+)'\)/);
      expect(b64Match).not.toBeNull();
      const decoded = Buffer.from(b64Match[1], 'base64').toString('utf16le');
      expect(decoded).toBe(name);

      // Exact escaping structure in PowerShell
      expect(script).toContain("$escapedPrinterName = $printerName.Replace('\\', '\\\\').Replace('''', '\\''')");
      expect(script).toContain("$filter = 'Name = ''' + $escapedPrinterName + ''''");
      expect(script).toContain('Get-CimInstance -ClassName Win32_Printer -Filter $filter');

      // No broad unfiltered printer enumeration
      expect(script).not.toContain('Where-Object');
      expect(script).not.toMatch(/Get-CimInstance\s+-ClassName\s+Win32_Printer\s*\|/);

      // Simulated WQL filter calculation matches expected escaping
      const simulatedEscaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const simulatedFilter = `Name = '${simulatedEscaped}'`;
      expect(simulatedFilter).toBe(expectedWqlValue);
    }
  });

  (process.platform === 'win32' ? test : test.skip)('executes PowerShell transformation on Windows runtime and verifies exact escaped WQL values', () => {
    const { execFileSync } = require('child_process');
    const cases = [
      {
        name: 'Server\\Printer',
        expectedEscaped: 'Server\\\\Printer',
        expectedFilter: "Name = 'Server\\\\Printer'"
      },
      {
        name: "Bob's Printer",
        expectedEscaped: "Bob\\'s Printer",
        expectedFilter: "Name = 'Bob\\'s Printer'"
      },
      {
        name: "Server\\Bob's Printer",
        expectedEscaped: "Server\\\\Bob\\'s Printer",
        expectedFilter: "Name = 'Server\\\\Bob\\'s Printer'"
      }
    ];

    for (const { name, expectedEscaped, expectedFilter } of cases) {
      const generatedCommand = SpoolerMonitor.buildPrinterStatusCommand(name);
      const probeCommand = generatedCommand + '; [PSCustomObject]@{ Escaped = $escapedPrinterName; Filter = $filter } | ConvertTo-Json -Compress';
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probeCommand], {
        encoding: 'utf8'
      });
      const parsed = JSON.parse(output.trim());
      expect(parsed.Escaped).toBe(expectedEscaped);
      expect(parsed.Filter).toBe(expectedFilter);
    }
  }, 30000);

  (process.platform === 'win32' ? test : test.skip)('executes exact generated command on Windows returning empty result without unfiltered enumeration', () => {
    const { execFileSync } = require('child_process');
    const nonExistent = "NonExistent_Printer_Queue_XYZ_'Quote'\\Backslash";
    const command = SpoolerMonitor.buildPrinterStatusCommand(nonExistent);
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8'
    });
    expect(output.trim()).toBe('');
  }, 15000);

  (process.platform === 'win32' ? test : test.skip)('executes exact PowerShell command with sentinel side-effect payloads and proves no execution, no sentinel creation, and no unfiltered query', () => {
    const { execFileSync } = require('child_process');
    const os = require('os');
    const path = require('path');
    const fsActual = jest.requireActual('fs');

    const sentinelFile = path.join(os.tmpdir(), `printgo_sentinel_${Date.now()}.txt`);
    if (fsActual.existsSync(sentinelFile)) {
      fsActual.unlinkSync(sentinelFile);
    }

    const escapedSentinelPath = sentinelFile.replace(/\\/g, '\\\\');
    const maliciousNames = [
      `FakePrinter'; [System.IO.File]::WriteAllText('${escapedSentinelPath}', 'PWNED'); #`,
      `FakePrinter"; Out-File -FilePath '${escapedSentinelPath}' -InputObject 'PWNED'; #`,
      `FakePrinter | Out-File '${escapedSentinelPath}' #`,
      `FakePrinter' $(New-Item -Path '${escapedSentinelPath}' -ItemType File) '`,
      `FakePrinter; Start-Process powershell -ArgumentList '-NoProfile','-Command','New-Item -Path \"${escapedSentinelPath}\"' -NoNewWindow; #`
    ];

    try {
      for (const fakeName of maliciousNames) {
        const command = SpoolerMonitor.buildPrinterStatusCommand(fakeName);

        // Execute the exact command with PowerShell
        const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
          encoding: 'utf8',
          timeout: 10000
        });

        // 1. No output emitted (no unfiltered enumeration of installed printers)
        expect(output.trim()).toBe('');

        // 2. Sentinel file must NOT have been created by side effects
        expect(fsActual.existsSync(sentinelFile)).toBe(false);

        // 3. Inspect runtime $filter to verify it remains a single literal printer name match
        const probeCommand = command + '; [PSCustomObject]@{ Filter = $filter } | ConvertTo-Json -Compress';
        const probeOutput = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probeCommand], {
          encoding: 'utf8',
          timeout: 10000
        });
        const parsed = JSON.parse(probeOutput.trim());
        expect(parsed.Filter).toMatch(/^Name = '.*'$/);
      }
    } finally {
      if (fsActual.existsSync(sentinelFile)) {
        fsActual.unlinkSync(sentinelFile);
      }
    }
  }, 45000);

  (process.platform === 'win32' ? test : test.skip)('executes apostrophes, backslashes, double quotes, semicolons, and OR 1=1 through the actual generated command on Windows', () => {
    const { execFileSync } = require('child_process');
    const testCases = [
      {
        name: "Test'Printer",
        expectedEscaped: "Test\\'Printer",
        expectedFilter: "Name = 'Test\\'Printer'"
      },
      {
        name: "Test\\Printer",
        expectedEscaped: "Test\\\\Printer",
        expectedFilter: "Name = 'Test\\\\Printer'"
      },
      {
        name: 'Test"Printer',
        expectedEscaped: 'Test"Printer',
        expectedFilter: "Name = 'Test\"Printer'"
      },
      {
        name: 'Test;Printer',
        expectedEscaped: 'Test;Printer',
        expectedFilter: "Name = 'Test;Printer'"
      },
      {
        name: "Test' OR 1=1 --",
        expectedEscaped: "Test\\' OR 1=1 --",
        expectedFilter: "Name = 'Test\\' OR 1=1 --'"
      },
      {
        name: "Test\\Queue's \"Main\"; OR 1=1 --",
        expectedEscaped: "Test\\\\Queue\\'s \"Main\"; OR 1=1 --",
        expectedFilter: "Name = 'Test\\\\Queue\\'s \"Main\"; OR 1=1 --'"
      }
    ];

    for (const { name, expectedEscaped, expectedFilter } of testCases) {
      const command = SpoolerMonitor.buildPrinterStatusCommand(name);

      // Execute exact command: returns empty because no printer matches this literal name
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        timeout: 10000
      });
      expect(output.trim()).toBe('');

      // Probe runtime variable values
      const probeCommand = command + '; [PSCustomObject]@{ Escaped = $escapedPrinterName; Filter = $filter } | ConvertTo-Json -Compress';
      const probeOutput = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probeCommand], {
        encoding: 'utf8',
        timeout: 10000
      });
      const parsed = JSON.parse(probeOutput.trim());
      expect(parsed.Escaped).toBe(expectedEscaped);
      expect(parsed.Filter).toBe(expectedFilter);
    }
  }, 45000);

  test('rejects invalid or unsafe printer name inputs safely', () => {
    const invalidInputs = [
      null,
      undefined,
      '',
      '   ',
      12345,
      {},
      'Printer\0Name',
      'Printer\r\nName'
    ];

    for (const invalid of invalidInputs) {
      expect(() => SpoolerMonitor.buildPrinterStatusCommand(invalid)).toThrow(TypeError);
    }
  });

  test('encodes both queue and job identifiers for spooler polling and removal', () => {
    const queueName = "Office Printer 'Primary'";
    const jobId = 'job-123';
    const queueEncoded = Buffer.from(queueName, 'utf16le').toString('base64');
    const jobEncoded = Buffer.from(jobId, 'utf16le').toString('base64');

    const query = SpoolerMonitor.buildPrintJobQueryCommand(queueName);
    const remove = SpoolerMonitor.buildRemovePrintJobCommand(queueName, jobId);

    expect(query).toContain(`FromBase64String('${queueEncoded}')`);
    expect(query).not.toContain(queueName);
    expect(remove).toContain(`FromBase64String('${queueEncoded}')`);
    expect(remove).toContain(`FromBase64String('${jobEncoded}')`);
    expect(remove).not.toContain(queueName);
    expect(remove).not.toContain(jobId);
  });
});

describe('SpoolerMonitor', () => {
  let mockExecFile;
  let mockSocket;
  let monitor;

  beforeEach(() => {
    mockExecFile = jest.fn();
    mockSocket = {
      emit: jest.fn()
    };
    
    monitor = new SpoolerMonitor({
      execFile: mockExecFile,
      printerName: 'TestPrinter',
      platform: 'win32',
      tcpChecker: jest.fn().mockResolvedValue({ isOnline: true, error: null })
    });
    
    fs.existsSync.mockReturnValue(true);
    fs.unlinkSync.mockClear();
  });

  describe('checkPrinterStatus', () => {
    it('handles invalid or malformed printerName inputs safely without spawning subprocess', () => {
      // Truthy invalid values throw in buildPrinterStatusCommand and emit fail-closed error status
      const truthyInvalidInputs = [
        '   ',
        12345,
        {},
        'Printer\0Name',
        'Printer\r\nName'
      ];

      for (const invalidName of truthyInvalidInputs) {
        mockExecFile.mockClear();
        mockSocket.emit.mockClear();

        const invalidMonitor = new SpoolerMonitor({
          execFile: mockExecFile,
          printerName: invalidName,
          platform: 'win32'
        });

        invalidMonitor.checkPrinterStatus(mockSocket);

        expect(mockExecFile).not.toHaveBeenCalled();
        expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
          isError: true,
          errorMessage: 'Invalid printer queue name'
        }));
        expect(invalidMonitor.isCheckingStatus).toBe(false);
      }

      // Falsy inputs (null, undefined, '') return early without spawning subprocess
      const falsyInputs = [null, undefined, ''];
      for (const falsyName of falsyInputs) {
        mockExecFile.mockClear();
        mockSocket.emit.mockClear();

        const falsyMonitor = new SpoolerMonitor({
          execFile: mockExecFile,
          printerName: falsyName,
          platform: 'win32'
        });

        falsyMonitor.checkPrinterStatus(mockSocket);

        expect(mockExecFile).not.toHaveBeenCalled();
        expect(mockSocket.emit).not.toHaveBeenCalled();
        expect(falsyMonitor.isCheckingStatus).toBe(false);
      }
    });

    it('includes PrinterDeviceId only for a device-scoped monitor', () => {
      const deviceMonitor = new SpoolerMonitor({
        execFile: mockExecFile,
        printerName: 'Epson L6460',
        printerDeviceId: 'device-123',
        platform: 'win32'
      });

      deviceMonitor.emitStatus(mockSocket, false, '', 'USB');

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        printerName: 'Epson L6460',
        printerDeviceId: 'device-123',
        isError: false
      }));
    });
    it('normalizes multiline and oversized error messages to the backend telemetry contract', () => {
      const deviceMonitor = new SpoolerMonitor({ execFile: mockExecFile, printerName: 'Epson L6460', printerDeviceId: 'device-123', platform: 'win32' });
      deviceMonitor.emitStatus(mockSocket, true, 'Query Error: first line\r\nsecond line ' + 'x'.repeat(180), 'USB');
      const payload = mockSocket.emit.mock.calls.at(-1)[1];
      expect(payload.errorMessage).toHaveLength(128);
      expect(payload.errorMessage).toContain('first line second line');
      expect(/[\u0000-\u001f\u007f]/.test(payload.errorMessage)).toBe(false);
    });

    it('should emit status OK when printer is healthy (DetectedErrorState: 2)', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus: 3, DetectedErrorState: 2, WorkOffline: False, PortName: USB001');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: false,
        errorMessage: '',
        printerName: 'TestPrinter'
      }));
    });

    it('should emit non-blocking status with PRINTER_STATE_UNKNOWN on DetectedErrorState 0 when idle', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus: 3, DetectedErrorState: 0, WorkOffline: False, PortName: USB001');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: false,
        errorMessage: '',
        printerName: 'TestPrinter',
        telemetry: expect.objectContaining({
          diagnosticReason: 'PRINTER_STATE_UNKNOWN'
        })
      }));
    });

    it('should emit blocking Printer Offline on DetectedErrorState 0 when WorkOffline is True', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus: 3, DetectedErrorState: 0, WorkOffline: True');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: true,
        errorMessage: 'Printer Offline',
        printerName: 'TestPrinter'
      }));
    });

    it('should emit Printer Error on DetectedErrorState 1 (Other)', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus: 3, DetectedErrorState: 1');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: true,
        errorMessage: 'Printer Error',
        printerName: 'TestPrinter'
      }));
    });

    it('should emit Paper Out error', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'ErrorState: 4, Paper Out');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: true,
        errorMessage: 'Out of Paper'
      }));
    });

    it('should emit Paper Jam error on DetectedErrorState 8', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'DetectedErrorState : 8');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: true,
        errorMessage: 'Paper Jam'
      }));
    });

    it('should emit Low Toner warning (isError: false) on DetectedErrorState 5', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus: 3, DetectedErrorState : 5, WorkOffline: False, PortName: USB001');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: false,
        errorMessage: 'Low Toner'
      }));
    });

    it('should emit Low Paper warning (isError: false) on DetectedErrorState 3', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus: 3, DetectedErrorState : 3, WorkOffline: False, PortName: USB001');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: false,
        errorMessage: 'Low Paper'
      }));
    });

    it('should emit healthy status on DetectedErrorState 2 (No Error)', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus: 3, DetectedErrorState : 2, WorkOffline: False, PortName: USB001');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: false,
        errorMessage: ''
      }));
    });

    it('should emit Door Open error on DetectedErrorState 7', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'DetectedErrorState : 7');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: true,
        errorMessage: 'Door Open'
      }));
    });

    it('should emit Printer Offline error on WorkOffline True', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'WorkOffline : True\nDetectedErrorState : 2');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: true,
        errorMessage: 'Printer Offline'
      }));
    });

    it('should emit missing or renamed queue error when PowerShell returns empty output', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, '   \r\n');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: true,
        errorMessage: 'Printer Queue Missing or Renamed',
        printerName: 'TestPrinter'
      }));
    });

    it('logs structured PowerShell stderr, exit code and timeout metadata without exposing it to status clients', () => {
      const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        const error = new Error('PowerShell execution failed');
        error.code = 5;
        error.errno = 'EACCES';
        callback(error, '', 'Access is denied');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"category":"windows-printer-status"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"exitCode":5'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"stderr":"Access is denied"'));
      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: true,
        errorMessage: 'Windows printer status query failed'
      }));
      logSpy.mockRestore();
    });

    it('should detect USB connection for USB019 or USB-prefixed port', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus : 3\r\nPortName : USB019\r\nWorkOffline : False');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        printerName: 'TestPrinter',
        connectionType: 'USB',
        telemetry: expect.objectContaining({
          connectionType: 'USB',
          portName: 'USB019'
        }),
        timestamp: expect.any(String)
      }));
    });


    it('requires a successful TCP probe for a network printer even when WMI says No Error', async () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus : 3\r\nDetectedErrorState : 2\r\nPortName : IP_192.168.1.150\r\nWorkOffline : False');
      });
      const tcpChecker = jest.fn().mockResolvedValue({ isOnline: false, error: 'ECONNREFUSED' });
      const networkMonitor = new SpoolerMonitor({ execFile: mockExecFile, printerName: 'NetworkPrinter', platform: 'win32', tcpChecker });

      networkMonitor.checkPrinterStatus(mockSocket);
      await jest.advanceTimersByTimeAsync(0);

      expect(tcpChecker).toHaveBeenCalledWith({ host: '192.168.1.150', port: 9100 });
      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: true, errorMessage: 'Network Printer Unreachable',
        telemetry: expect.objectContaining({ diagnosticReason: 'NETWORK_UNREACHABLE' })
      }));
    });

    it('keeps the status-check lock until the asynchronous network probe completes', async () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus : 3\r\nDetectedErrorState : 0\r\nPortName : IP_192.168.1.150\r\nWorkOffline : False');
      });
      let resolveProbe;
      const probePromise = new Promise((resolve) => { resolveProbe = resolve; });
      const tcpChecker = jest.fn(() => probePromise);
      const networkMonitor = new SpoolerMonitor({ execFile: mockExecFile, printerName: 'NetworkPrinter', platform: 'win32', tcpChecker });

      networkMonitor.checkPrinterStatus(mockSocket);
      await Promise.resolve();
      expect(networkMonitor.isCheckingStatus).toBe(true);
      networkMonitor.checkPrinterStatus(mockSocket);
      expect(mockExecFile).toHaveBeenCalledTimes(1);

      resolveProbe({ isOnline: true, error: null });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({ isError: false }));
      expect(networkMonitor.isCheckingStatus).toBe(false);
    });

    it('should detect Network connection for TCP/IP or WSD port', async () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus : 3\r\nDetectedErrorState : 0\r\nPortName : IP_192.168.1.150\r\nWorkOffline : False');
      });

      monitor.checkPrinterStatus(mockSocket);
      await Promise.resolve();

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        printerName: 'TestPrinter',
        connectionType: 'Network',
        telemetry: expect.objectContaining({
          connectionType: 'Network',
          portName: 'IP_192.168.1.150'
        }),
        timestamp: expect.any(String)
      }));
    });

    it('should classify unrecognized or missing port as Unknown', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus : 3\r\nPortName : PORTPROMPT:\r\nWorkOffline : False');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        printerName: 'TestPrinter',
        connectionType: 'Unknown',
        telemetry: expect.objectContaining({
          connectionType: 'Unknown'
        }),
        timestamp: expect.any(String)
      }));
    });
  });

  describe('classifyConnection', () => {
    it('classifies USB ports correctly', () => {
      expect(SpoolerMonitor.classifyConnection('USB019')).toBe('USB');
      expect(SpoolerMonitor.classifyConnection('USB001')).toBe('USB');
      expect(SpoolerMonitor.classifyConnection('usb://EPSON/L6460')).toBe('USB');
    });

    it('classifies Network ports correctly', () => {
      expect(SpoolerMonitor.classifyConnection('IP_192.168.1.100')).toBe('Network');
      expect(SpoolerMonitor.classifyConnection('192.168.1.50')).toBe('Network');
      expect(SpoolerMonitor.classifyConnection('WSD-abcd-1234')).toBe('Network');
      expect(SpoolerMonitor.classifyConnection('TCP_PRINTER')).toBe('Network');
      expect(SpoolerMonitor.classifyConnection('socket://192.168.1.50:9100')).toBe('Network');
      expect(SpoolerMonitor.classifyConnection('ipp://printer.local/ipp/print')).toBe('Network');
    });

    it('classifies unrecognized or empty ports as Unknown', () => {
      expect(SpoolerMonitor.classifyConnection('PORTPROMPT:')).toBe('Unknown');
      expect(SpoolerMonitor.classifyConnection('nul:')).toBe('Unknown');
      expect(SpoolerMonitor.classifyConnection('COM1:')).toBe('Unknown');
      expect(SpoolerMonitor.classifyConnection('LPT1:')).toBe('Unknown');
      expect(SpoolerMonitor.classifyConnection('')).toBe('Unknown');
      expect(SpoolerMonitor.classifyConnection(null)).toBe('Unknown');
      expect(SpoolerMonitor.classifyConnection(undefined)).toBe('Unknown');
    });
  });

  describe('startPollingJob', () => {
    it('should emit physical success when job is cleared from queue', () => {
      const jobId = 'job123';
      
      let callCount = 0;
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callCount++;
        if (callCount === 1) {
          // First poll: Job is in queue
          callback(null, JSON.stringify({ DocumentName: jobId, JobStatus: 'Printing' }));
        } else {
          // Second poll: Job is gone (success)
          callback(null, '');
        }
      });

      monitor.startPollingJob(jobId, 'temp.pdf', mockSocket);
      
      // Advance timers by 2 seconds (1st poll: in queue)
      jest.advanceTimersByTime(2000);
      expect(mockSocket.emit).not.toHaveBeenCalledWith('print_physical_success', expect.any(Object));
      
      // Advance timers by 2 seconds (2nd poll: cleared from queue)
      jest.advanceTimersByTime(2000);
      expect(mockSocket.emit).toHaveBeenCalledWith('print_physical_success', expect.objectContaining({ jobId }));
      expect(fs.unlinkSync).toHaveBeenCalledWith('temp.pdf');
    });

    it('keeps a never-observed fast-clearing job ambiguous instead of reporting false success', () => {
      const jobId = 'job-fast-clear';

      // The queue is empty on every poll: there is no positive evidence that
      // this particular job entered the spooler or physically completed.
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, '');
      });

      monitor.startPollingJob(jobId, 'temp.pdf', mockSocket);

      jest.advanceTimersByTime(6000);
      expect(mockSocket.emit).not.toHaveBeenCalledWith('print_physical_success', expect.any(Object));

      // The bounded polling window ends in AMBIGUOUS, not COMPLETED.
      jest.advanceTimersByTime(116000);
      expect(mockSocket.emit).toHaveBeenCalledWith('print_physical_ambiguous', expect.objectContaining({
        jobId,
        wasSeenInQueue: false,
        reason: 'Job was never observed in queue within timeout window'
      }));
      expect(mockSocket.emit).not.toHaveBeenCalledWith('print_physical_success', expect.any(Object));
    });

    it('should emit physical error if spooler reports PaperJam', () => {
      const jobId = 'job456';
      
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        if (args.join(' ').includes('Remove-PrintJob')) return; // ignore delete call
        callback(null, JSON.stringify({ DocumentName: jobId, JobStatus: 'PaperJam' }));
      });

      monitor.startPollingJob(jobId, 'temp.pdf', mockSocket);
      
      jest.advanceTimersByTime(2000);
      expect(mockSocket.emit).toHaveBeenCalledWith('print_physical_error', { jobId, error: 'PaperJam' });
      expect(fs.unlinkSync).toHaveBeenCalledWith('temp.pdf');
    });

    it('should timeout and emit physical error if job stays in queue > 2 minutes', () => {
      const jobId = 'job789';
      
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, JSON.stringify({ DocumentName: jobId, JobStatus: 'Printing' }));
      });

      monitor.startPollingJob(jobId, 'temp.pdf', mockSocket);
      
      // Advance by 120 seconds (60 intervals of 2000ms)
      jest.advanceTimersByTime(120000);
      expect(mockSocket.emit).not.toHaveBeenCalledWith('print_physical_ambiguous', expect.any(Object));

      // Advance past 120 seconds
      jest.advanceTimersByTime(2000);
      expect(mockSocket.emit).toHaveBeenCalledWith('print_physical_ambiguous', expect.objectContaining({ jobId }));
    });
  });
});
