const fs = require('fs');
const SpoolerMonitor = require('../src/spooler');

jest.mock('fs');
jest.useFakeTimers();

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
      printerName: 'TestPrinter' 
    });
    
    fs.existsSync.mockReturnValue(true);
    fs.unlinkSync.mockClear();
  });

  describe('checkPrinterStatus', () => {
    it('should emit status OK when printer is healthy', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'PrinterStatus: 3, ErrorState: 0');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: false,
        errorMessage: '',
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

    it('should emit Paper Jam error', () => {
      mockExecFile.mockImplementation((cmd, args, a3, a4) => {
        const callback = typeof a3 === 'function' ? a3 : a4;
        callback(null, 'ErrorState: 5');
      });

      monitor.checkPrinterStatus(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith('printer_status_update', expect.objectContaining({
        isError: true,
        errorMessage: 'Paper Jam'
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
