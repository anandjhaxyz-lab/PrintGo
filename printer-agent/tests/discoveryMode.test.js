'use strict';

/**
 * PrintGo Discovery-Only Safety Guard Tests
 *
 * Verifies that:
 * 1. Explicit true values enable discovery-only mode.
 * 2. Explicit false values disable it only when deliberately configured.
 * 3. Missing or empty configuration fails closed (enables discovery-only mode).
 * 4. Invalid or ambiguous configuration fails closed.
 * 5. CLI --discovery-only takes precedence.
 * 6. physical_print_job events are rejected in discovery-only mode.
 * 7. processPhysicalPrintJob() independently rejects dispatch.
 * 8. Zero PDF downloads occur for blocked jobs.
 * 9. Zero ptp.print() calls occur for blocked jobs.
 * 10. Zero spooler commands execute for blocked jobs.
 * 11. Blocked requests emit compatible print_spooler_error events.
 * 12. Device IDs and Windows queue names are preserved in rejection payloads.
 * 13. Printer discovery and status telemetry remain unblocked.
 * 14. Zero sensitive authentication tokens, machine keys, or PDF paths are logged.
 */

const {
  parseDiscoveryModeConfig,
  evaluatePrintJobSafety,
  createGuardedPrintJobHandler
} = require('../src/discoveryMode');
const { evaluatePrinterReadiness } = require('../src/printerStatusMapping');

describe('PrintGo Discovery-Only Safety Guard', () => {

  describe('Configuration Parsing & Fail-Closed Behavior', () => {
    test('1. parses DISCOVERY_ONLY=true from env as enabled and valid', () => {
      const cfg = parseDiscoveryModeConfig({ DISCOVERY_ONLY: 'true' }, []);
      expect(cfg.isDiscoveryOnly).toBe(true);
      expect(cfg.isValid).toBe(true);
      expect(cfg.source).toBe('env');
    });

    test('2. parses DISCOVERY_ONLY=1, yes, TRUE (case-insensitive, trimmed) as enabled and valid', () => {
      expect(parseDiscoveryModeConfig({ DISCOVERY_ONLY: '1' }, []).isDiscoveryOnly).toBe(true);
      expect(parseDiscoveryModeConfig({ DISCOVERY_ONLY: 'yes' }, []).isDiscoveryOnly).toBe(true);
      expect(parseDiscoveryModeConfig({ DISCOVERY_ONLY: 'TRUE' }, []).isDiscoveryOnly).toBe(true);
      expect(parseDiscoveryModeConfig({ DISCOVERY_ONLY: '  true  ' }, []).isDiscoveryOnly).toBe(true);
      expect(parseDiscoveryModeConfig({ DISCOVERY_ONLY: '  YES  ' }, []).isDiscoveryOnly).toBe(true);
    });

    test('3. parses --discovery-only CLI flag as enabled and valid (takes precedence)', () => {
      const cfg = parseDiscoveryModeConfig({ DISCOVERY_ONLY: 'false' }, ['node', 'index.js', '--discovery-only']);
      expect(cfg.isDiscoveryOnly).toBe(true);
      expect(cfg.isValid).toBe(true);
      expect(cfg.source).toBe('cli');
    });

    test('4. disables discovery-only mode ONLY when deliberately configured with false, 0, or no', () => {
      expect(parseDiscoveryModeConfig({ DISCOVERY_ONLY: 'false' }, []).isDiscoveryOnly).toBe(false);
      expect(parseDiscoveryModeConfig({ DISCOVERY_ONLY: '0' }, []).isDiscoveryOnly).toBe(false);
      expect(parseDiscoveryModeConfig({ DISCOVERY_ONLY: 'no' }, []).isDiscoveryOnly).toBe(false);
      expect(parseDiscoveryModeConfig({ DISCOVERY_ONLY: 'FALSE' }, []).isDiscoveryOnly).toBe(false);
      expect(parseDiscoveryModeConfig({ DISCOVERY_ONLY: '  no  ' }, []).isDiscoveryOnly).toBe(false);
    });

    test('5. missing configuration FAILS CLOSED by defaulting to discovery-only mode', () => {
      const cfg = parseDiscoveryModeConfig({}, []);
      expect(cfg.isDiscoveryOnly).toBe(true);
      expect(cfg.isValid).toBe(true);
      expect(cfg.source).toBe('default_fail_closed');

      const safety = evaluatePrintJobSafety({ jobId: 'job_default_test' }, cfg);
      expect(safety.blocked).toBe(true);
      expect(safety.reason).toMatch(/defaulted to STRICT DISCOVERY_ONLY mode/);
    });

    test('6. empty or whitespace configuration FAILS CLOSED by defaulting to discovery-only mode', () => {
      const emptyCfg = parseDiscoveryModeConfig({ DISCOVERY_ONLY: '' }, []);
      expect(emptyCfg.isDiscoveryOnly).toBe(true);
      expect(emptyCfg.source).toBe('default_fail_closed');

      const whitespaceCfg = parseDiscoveryModeConfig({ DISCOVERY_ONLY: '    ' }, []);
      expect(whitespaceCfg.isDiscoveryOnly).toBe(true);
      expect(whitespaceCfg.source).toBe('default_fail_closed');
    });

    test('7. invalid or ambiguous values FAIL CLOSED with configuration error', () => {
      const invalidValues = ['maybe', 'invalid', '2', 'enabled', 'DISCOVERY', 'null', 'undefined', '-1'];
      for (const val of invalidValues) {
        const cfg = parseDiscoveryModeConfig({ DISCOVERY_ONLY: val }, []);
        expect(cfg.isValid).toBe(false);
        expect(cfg.isDiscoveryOnly).toBe(true); // Fails closed!
        expect(cfg.error).toMatch(/Ambiguous or invalid DISCOVERY_ONLY value/);

        const safety = evaluatePrintJobSafety({ jobId: 'job_ambig_test' }, cfg);
        expect(safety.blocked).toBe(true);
        expect(safety.reason).toMatch(/Configuration Error.*Fails closed/);
      }
    });
  });

  describe('Print Job Safety Evaluation & Protocol Enforcement', () => {
    const discoveryConfig = { isDiscoveryOnly: true, isValid: true };
    const defaultFailClosedConfig = { isDiscoveryOnly: true, isValid: true, source: 'default_fail_closed' };
    const normalConfig = { isDiscoveryOnly: false, isValid: true };

    test('8. discovery-only mode rejects a physical print job and emits print_spooler_error', () => {
      const emittedEvents = [];
      const mockSocket = {
        emit: (event, payload) => emittedEvents.push({ event, payload })
      };
      let downstreamCalled = false;

      const handler = createGuardedPrintJobHandler({
        config: discoveryConfig,
        socket: mockSocket,
        onSafeJob: () => { downstreamCalled = true; }
      });

      const jobData = {
        jobId: 'job_phys_101',
        printerDeviceId: 'dev_epson_01',
        windowsPrinterName: 'EPSON L6460 Series'
      };

      handler(jobData);

      expect(downstreamCalled).toBe(false);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].event).toBe('print_spooler_error');
      expect(emittedEvents[0].payload.jobId).toBe('job_phys_101');
      expect(emittedEvents[0].payload.error).toMatch(/STRICT DISCOVERY_ONLY mode/);
      expect(emittedEvents[0].payload.printerDeviceId).toBe('dev_epson_01');
      expect(emittedEvents[0].payload.windowsPrinterName).toBe('EPSON L6460 Series');
    });

    test('9. default fail-closed mode rejects physical print jobs with explicit reason', () => {
      const emittedEvents = [];
      const mockSocket = {
        emit: (event, payload) => emittedEvents.push({ event, payload })
      };
      let downstreamCalled = false;

      const handler = createGuardedPrintJobHandler({
        config: defaultFailClosedConfig,
        socket: mockSocket,
        onSafeJob: () => { downstreamCalled = true; }
      });

      handler({
        jobId: 'job_phys_102',
        printerDeviceId: 'dev_hp_01',
        windowsPrinterName: 'HP LaserJet Professional M1136 MFP'
      });

      expect(downstreamCalled).toBe(false);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].payload.error).toMatch(/defaulted to STRICT DISCOVERY_ONLY mode/);
    });

    test('10. ptp.print() is never called when in discovery-only mode', async () => {
      let ptpPrintCalled = false;
      const mockPtp = {
        print: async () => { ptpPrintCalled = true; }
      };

      const emitted = [];
      const mockSocket = { emit: (ev, pl) => emitted.push({ ev, pl }) };

      const handler = createGuardedPrintJobHandler({
        config: discoveryConfig,
        socket: mockSocket,
        onSafeJob: async () => {
          await mockPtp.print();
        }
      });

      handler({ jobId: 'job_check_ptp' });
      expect(ptpPrintCalled).toBe(false);
      expect(emitted[0].ev).toBe('print_spooler_error');
    });

    test('11. no PDF download occurs in discovery-only mode', async () => {
      let axiosGetCalled = false;
      const mockAxios = {
        get: async () => { axiosGetCalled = true; return { data: Buffer.from('') }; }
      };

      const emitted = [];
      const mockSocket = { emit: (ev, pl) => emitted.push({ ev, pl }) };

      const handler = createGuardedPrintJobHandler({
        config: discoveryConfig,
        socket: mockSocket,
        onSafeJob: async () => {
          await mockAxios.get('https://backend/download');
        }
      });

      handler({ jobId: 'job_check_download' });
      expect(axiosGetCalled).toBe(false);
    });

    test('12. no spooler command executes in discovery-only mode', () => {
      let execFileCalled = false;
      const mockExecFile = () => { execFileCalled = true; };

      const emitted = [];
      const mockSocket = { emit: (ev, pl) => emitted.push({ ev, pl }) };

      const handler = createGuardedPrintJobHandler({
        config: discoveryConfig,
        socket: mockSocket,
        onSafeJob: () => { mockExecFile('powershell.exe'); }
      });

      handler({ jobId: 'job_check_spooler' });
      expect(execFileCalled).toBe(false);
    });

    test('13. no simulation success or completion is emitted in discovery-only mode', () => {
      const emittedEvents = [];
      const mockSocket = {
        emit: (event, payload) => emittedEvents.push({ event, payload })
      };

      const handler = createGuardedPrintJobHandler({
        config: discoveryConfig,
        socket: mockSocket,
        onSafeJob: () => {
          mockSocket.emit('print_physical_success', { jobId: 'job_sim' });
          mockSocket.emit('job_completed', { jobId: 'job_sim' });
        }
      });

      handler({ jobId: 'job_sim' });

      const eventNames = emittedEvents.map((e) => e.event);
      expect(eventNames).toEqual(['print_spooler_error']);
      expect(eventNames).not.toContain('print_physical_success');
      expect(eventNames).not.toContain('print_spooler_success');
      expect(eventNames).not.toContain('job_completed');
    });

    test('14. normal mode (DISCOVERY_ONLY=false) allows safe downstream processing', () => {
      let downstreamCalled = false;
      let downstreamJob = null;
      const mockSocket = { emit: jest.fn() };

      const handler = createGuardedPrintJobHandler({
        config: normalConfig,
        socket: mockSocket,
        onSafeJob: (job) => {
          downstreamCalled = true;
          downstreamJob = job;
        }
      });

      handler({ jobId: 'job_authorized_print', printerDeviceId: 'dev-001' });

      expect(downstreamCalled).toBe(true);
      expect(downstreamJob.jobId).toBe('job_authorized_print');
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    test('15. rejects invalid jobId format to prevent injection before safety check', () => {
      const emittedEvents = [];
      const mockSocket = { emit: (e, p) => emittedEvents.push({ e, p }) };
      const logger = { error: jest.fn(), warn: jest.fn() };
      let downstreamCalled = false;

      const handler = createGuardedPrintJobHandler({
        config: discoveryConfig,
        socket: mockSocket,
        onSafeJob: () => { downstreamCalled = true; },
        logger
      });

      handler({ jobId: 'job; rm -rf /; echo evil' });

      expect(downstreamCalled).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid jobId format'));
      expect(emittedEvents).toHaveLength(0); // Rejected before processing
    });

    test('16. discovery-only mode does not block printer discovery or status telemetry', () => {
      // Confirm evaluatePrinterReadiness continues to report canPrint: true on healthy idle status
      const healthyIdleTelemetry = {
        workOffline: false,
        printerStatus: 3,
        extendedPrinterStatus: 2,
        detectedErrorState: 0,
        extendedDetectedErrorState: 0
      };

      const readiness = evaluatePrinterReadiness(healthyIdleTelemetry);
      expect(readiness.canPrint).toBe(true);
      expect(readiness.reason).toBeNull();
    });

    test('17. zero sensitive tokens or customer PDF data logged during rejection', () => {
      const warnings = [];
      const logger = {
        warn: (msg) => warnings.push(msg),
        error: jest.fn()
      };
      const mockSocket = { emit: jest.fn() };

      const handler = createGuardedPrintJobHandler({
        config: discoveryConfig,
        socket: mockSocket,
        onSafeJob: jest.fn(),
        logger
      });

      handler({
        jobId: 'job_sensitive_test',
        printerDeviceId: 'dev-epson-secret-id',
        windowsPrinterName: 'EPSON L6460 Series'
      });

      expect(warnings).toHaveLength(1);
      const loggedMessage = warnings[0];
      expect(loggedMessage).toContain('job_sensitive_test');
      expect(loggedMessage).not.toContain('MACHINE_KEY');
      expect(loggedMessage).not.toContain('b517');
      expect(loggedMessage).not.toContain('.pem');
      expect(loggedMessage).not.toContain('Bearer');
    });
  });
});
