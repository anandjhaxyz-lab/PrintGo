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
      platform: 'win32'
    });
    
    fs.existsSync.mockReturnValue(true);
    fs.unlinkSync.mockClear();
  });

  describe('checkPrinterStatus', () => {
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
    it('should emit status OK when printer is healthy (DetectedErrorState: 2)', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus: 3, DetectedErrorState: 2');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: false,
        errorMessage: '',
        printerName: 'TestPrinter'
      }));
    });

    it('should emit Printer State Unknown on DetectedErrorState 0 (Unknown)', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus: 3, DetectedErrorState: 0');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: true,
        errorMessage: 'Printer State Unknown',
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
        callback(null, 'DetectedErrorState : 5');
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
        callback(null, 'DetectedErrorState : 3');
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
        callback(null, 'DetectedErrorState : 2');
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

    it('should emit query error when PowerShell fails with an error', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(new Error('PowerShell execution failed'));
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: true,
        errorMessage: expect.stringContaining('PowerShell execution failed')
      }));
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

    it('should detect Network connection for TCP/IP or WSD port', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus : 3\r\nPortName : IP_192.168.1.150\r\nWorkOffline : False');
      });

      monitor.checkPrinterStatus(mockSocket);

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
