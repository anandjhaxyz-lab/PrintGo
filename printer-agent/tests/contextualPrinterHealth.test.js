const {
  WIN32_DETECTED_ERROR_STATE,
  interpretDetectedErrorState,
  evaluateContextualPrinterHealth
} = require('../src/printerStatusMapping');
const { parseTcpEndpoint, checkTcpConnectivity } = require('../src/networkConnectivity');
const { PrinterFleetManager } = require('../src/printerFleetManager');
const SpoolerMonitor = require('../src/spooler');

describe('Contextual Printer Health Policy & TCP Connectivity (Phase 6)', () => {
  // Helper to create mock discovered printer
  const mockDiscovered = (name, overrides = {}) => ({
    windowsPrinterName: name,
    driverName: `${name} Driver`,
    portName: 'USB001',
    connectionType: 'USB',
    printerStatus: 3, // Idle
    detectedErrorState: null,
    workOffline: false,
    shared: false,
    network: false,
    isDefault: false,
    ...overrides
  });

  // Helper to create mock approved device
  const mockApprovedDevice = (id, queueName, overrides = {}) => ({
    id,
    displayName: queueName,
    windowsPrinterName: queueName,
    status: 'ACTIVE',
    approvedAt: '2026-11-23T22:54:55.286Z',
    sortOrder: 0,
    ...overrides
  });

  // =========================================================================
  // Requirement 1: DetectedErrorState = 0, WorkOffline false, PrinterStatus Idle
  // =========================================================================
  test('Case 1: DetectedErrorState = 0, WorkOffline false, PrinterStatus Idle (3) is non-blocking with diagnostic reason', () => {
    const health = evaluateContextualPrinterHealth({
      detectedErrorState: 0,
      workOffline: false,
      printerStatus: 3,
      connectionType: 'USB'
    });

    expect(health.canPrint).toBe(true);
    expect(health.isError).toBe(false);
    expect(health.isUnknown).toBe(true);
    expect(health.reason).toBe('PRINTER_STATE_UNKNOWN');
    expect(health.paperStatus).toBe('UNKNOWN');
    expect(health.tonerStatus).toBe('UNKNOWN');
  });

  // =========================================================================
  // Requirement 2: DetectedErrorState = 0, WorkOffline false, PrinterStatus Printing
  // =========================================================================
  test('Case 2: DetectedErrorState = 0, WorkOffline false, PrinterStatus Printing (4) is non-blocking with diagnostic reason', () => {
    const health = evaluateContextualPrinterHealth({
      detectedErrorState: 0,
      workOffline: false,
      printerStatus: 4,
      connectionType: 'USB'
    });

    expect(health.canPrint).toBe(true);
    expect(health.isError).toBe(false);
    expect(health.isUnknown).toBe(true);
    expect(health.reason).toBe('PRINTER_STATE_UNKNOWN');
    expect(health.paperStatus).toBe('UNKNOWN');
    expect(health.tonerStatus).toBe('UNKNOWN');
  });

  // =========================================================================
  // Requirement 3: DetectedErrorState = 0, WorkOffline true — blocking
  // =========================================================================
  test('Case 3: DetectedErrorState = 0, WorkOffline true is strictly blocking', () => {
    const health = evaluateContextualPrinterHealth({
      detectedErrorState: 0,
      workOffline: true,
      printerStatus: 3,
      connectionType: 'USB'
    });

    expect(health.canPrint).toBe(false);
    expect(health.isError).toBe(true);
    expect(health.reason).toBe('PRINTER_OFFLINE');
    expect(health.message).toBe('Printer Offline');
  });

  // =========================================================================
  // Requirement 4: DetectedErrorState = 9 — blocking (Offline)
  // =========================================================================
  test('Case 4: DetectedErrorState = 9 (Offline) is strictly blocking even if WorkOffline is false', () => {
    const health = evaluateContextualPrinterHealth({
      detectedErrorState: 9,
      workOffline: false,
      printerStatus: 3,
      connectionType: 'USB'
    });

    expect(health.canPrint).toBe(false);
    expect(health.isError).toBe(true);
    expect(health.reason).toBe('PRINTER_OFFLINE');
    expect(health.message).toBe('Printer Offline');
  });

  // =========================================================================
  // Requirement 5: No Paper (DetectedErrorState = 4) — blocking
  // =========================================================================
  test('Case 5: No Paper (DetectedErrorState = 4) is strictly blocking', () => {
    const health = evaluateContextualPrinterHealth({
      detectedErrorState: 4,
      workOffline: false,
      printerStatus: 3,
      connectionType: 'USB'
    });

    expect(health.canPrint).toBe(false);
    expect(health.isError).toBe(true);
    expect(health.reason).toBe('PRINTER_NO_PAPER');
    expect(health.message).toBe('Out of Paper');
    expect(health.paperStatus).toBe('OUT');
  });

  // =========================================================================
  // Requirement 6: Paper Jam (DetectedErrorState = 8) — blocking
  // =========================================================================
  test('Case 6: Paper Jam (DetectedErrorState = 8) is strictly blocking', () => {
    const health = evaluateContextualPrinterHealth({
      detectedErrorState: 8,
      workOffline: false,
      printerStatus: 3,
      connectionType: 'USB'
    });

    expect(health.canPrint).toBe(false);
    expect(health.isError).toBe(true);
    expect(health.reason).toBe('PRINTER_PAPER_JAM');
    expect(health.message).toBe('Paper Jam');
  });

  // =========================================================================
  // Requirement 7: Door Open (DetectedErrorState = 7) — blocking
  // =========================================================================
  test('Case 7: Door Open (DetectedErrorState = 7) is strictly blocking', () => {
    const health = evaluateContextualPrinterHealth({
      detectedErrorState: 7,
      workOffline: false,
      printerStatus: 3,
      connectionType: 'USB'
    });

    expect(health.canPrint).toBe(false);
    expect(health.isError).toBe(true);
    expect(health.reason).toBe('PRINTER_DOOR_OPEN');
    expect(health.message).toBe('Door Open');
  });

  // =========================================================================
  // Requirement 8: Network printer with successful TCP connectivity
  // =========================================================================
  test('Case 8: Network printer with WMI Unknown and successful TCP connectivity is eligible to print', () => {
    const health = evaluateContextualPrinterHealth({
      detectedErrorState: 0,
      workOffline: false,
      printerStatus: 3,
      connectionType: 'Network',
      networkOnline: true,
      networkError: null
    });

    expect(health.canPrint).toBe(true);
    expect(health.isError).toBe(false);
    expect(health.isUnknown).toBe(true);
    expect(health.reason).toBe('PRINTER_STATE_UNKNOWN');
    expect(health.paperStatus).toBe('UNKNOWN');
    expect(health.tonerStatus).toBe('UNKNOWN');
  });

  // =========================================================================
  // Requirement 9: Network printer with failed TCP connectivity
  // =========================================================================
  test('Case 9: Network printer with failed TCP connectivity is strictly blocked from printing', () => {
    const health = evaluateContextualPrinterHealth({
      detectedErrorState: 0,
      workOffline: false,
      printerStatus: 3,
      connectionType: 'Network',
      networkOnline: false,
      networkError: 'ECONNREFUSED'
    });

    expect(health.canPrint).toBe(false);
    expect(health.isError).toBe(true);
    expect(health.reason).toBe('NETWORK_UNREACHABLE');
    expect(health.message).toBe('Network Printer Unreachable');
  });

  // =========================================================================
  // Requirement 10: Network printer with connectivity timeout
  // =========================================================================
  test('Case 10: Network printer with TCP timeout is strictly blocked with NETWORK_TIMEOUT', () => {
    const health = evaluateContextualPrinterHealth({
      detectedErrorState: 0,
      workOffline: false,
      printerStatus: 3,
      connectionType: 'Network',
      networkOnline: false,
      networkError: 'TIMED_OUT'
    });

    expect(health.canPrint).toBe(false);
    expect(health.isError).toBe(true);
    expect(health.reason).toBe('NETWORK_TIMEOUT');
    expect(health.message).toBe('Network Connectivity Timeout');
  });

  // =========================================================================
  // Requirement 11: USB printer with WMI Unknown
  // =========================================================================
  test('Case 11: USB printer with WMI Unknown preserves UNKNOWN consumables and distinguishable diagnostic reason', () => {
    const health = evaluateContextualPrinterHealth({
      detectedErrorState: 0,
      workOffline: false,
      printerStatus: 3,
      connectionType: 'USB'
    });

    expect(health.canPrint).toBe(true);
    expect(health.isError).toBe(false);
    expect(health.isUnknown).toBe(true);
    expect(health.reason).toBe('PRINTER_STATE_UNKNOWN');
    // Does NOT falsely claim consumables are healthy
    expect(health.paperStatus).toBe('UNKNOWN');
    expect(health.tonerStatus).toBe('UNKNOWN');
  });

  // =========================================================================
  // Requirement 12: Approved Epson receives an independent monitor
  // =========================================================================
  test('Case 12: Approved Epson receives an independent monitor when TCP connectivity succeeds', async () => {
    const epsonQueue = mockDiscovered('EPSON L6460 Series', {
      portName: '192.168.1.7',
      connectionType: 'Network',
      printerStatus: 3,
      detectedErrorState: 0,
      workOffline: false,
      isDefault: true
    });

    const epsonDevice = mockApprovedDevice('619665e1-3c64-44eb-8f57-cb8c3c895e9b', 'EPSON L6460 Series');

    const mockTcpChecker = jest.fn().mockResolvedValue({ isOnline: true, error: null });
    const mockMonitorFactory = jest.fn().mockImplementation(({ printerDevice, printerName }) => ({
      printerDeviceId: printerDevice.id,
      printerName,
      checkPrinterStatus: jest.fn()
    }));

    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [epsonQueue],
      getDeviceRegistry: async () => [epsonDevice],
      tcpChecker: mockTcpChecker,
      monitorFactory: mockMonitorFactory
    });

    const fleet = await manager.refresh();
    const epsonFleetDevice = fleet.find(d => d.id === epsonDevice.id);

    expect(epsonFleetDevice).toBeDefined();
    expect(epsonFleetDevice.canPrint).toBe(true);
    expect(manager.monitors.size).toBe(1);
    expect(manager.monitors.has(epsonDevice.id)).toBe(true);
    expect(mockTcpChecker).toHaveBeenCalledWith({ host: '192.168.1.7', port: 9100 });
    expect(mockMonitorFactory).toHaveBeenCalled();
  });

  // =========================================================================
  // Requirement 13: Unapproved device receives no monitor
  // =========================================================================
  test('Case 13: Unapproved device receives no monitor even if queue is healthy and online', async () => {
    const unapprovedQueue = mockDiscovered('HP LaserJet Pro', {
      portName: 'USB002',
      printerStatus: 3,
      detectedErrorState: 2,
      workOffline: false
    });

    const unapprovedDevice = mockApprovedDevice('unapproved-1', 'HP LaserJet Pro', {
      status: 'PENDING_APPROVAL',
      approvedAt: null
    });

    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [unapprovedQueue],
      getDeviceRegistry: async () => [unapprovedDevice],
      monitorFactory: jest.fn()
    });

    const fleet = await manager.refresh();
    const dev = fleet.find(d => d.id === 'unapproved-1');

    expect(dev.canPrint).toBe(false);
    expect(dev.reason).toBe('ADMIN_APPROVAL_REQUIRED');
    expect(manager.monitors.size).toBe(0);
  });

  // =========================================================================
  // Requirement 14: Missing approval evidence remains blocking
  // =========================================================================
  test('Case 14: Missing approval evidence (approvedAt null) remains blocking', async () => {
    const queue = mockDiscovered('Canon 4545', {
      portName: 'USB003',
      printerStatus: 3,
      detectedErrorState: 2,
      workOffline: false
    });

    const device = mockApprovedDevice('canon-1', 'Canon 4545', {
      status: 'ACTIVE',
      approvedAt: null
    });

    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [queue],
      getDeviceRegistry: async () => [device],
      monitorFactory: jest.fn()
    });

    const fleet = await manager.refresh();
    const dev = fleet.find(d => d.id === 'canon-1');

    expect(dev.canPrint).toBe(false);
    expect(dev.reason).toBe('APPROVAL_EVIDENCE_MISSING');
    expect(manager.monitors.size).toBe(0);
  });

  // =========================================================================
  // Requirement 15: Existing legacy fallback behavior remains correct
  // =========================================================================
  test('Case 15: When no approved device can print, fleetManager has 0 monitors and agent fallback runs', async () => {
    const offlineQueue = mockDiscovered('Offline Printer', {
      portName: 'USB001',
      workOffline: true
    });

    const offlineDevice = mockApprovedDevice('dev-offline', 'Offline Printer');

    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [offlineQueue],
      getDeviceRegistry: async () => [offlineDevice],
      monitorFactory: jest.fn()
    });

    const fleet = await manager.refresh();
    expect(manager.monitors.size).toBe(0);

    // Verify index.js fallback condition: fleetManager.monitors.size === 0
    const wouldUseFallback = manager.monitors.size === 0;
    expect(wouldUseFallback).toBe(true);
  });

  // =========================================================================
  // Additional TCP parsing & connectivity tests
  // =========================================================================
  describe('parseTcpEndpoint', () => {
    test('parses pure IPv4 address and defaults port to 9100', () => {
      expect(parseTcpEndpoint('192.168.1.7')).toEqual({ host: '192.168.1.7', port: 9100 });
    });

    test('parses IPv4 address with explicit port', () => {
      expect(parseTcpEndpoint('192.168.1.7:9101')).toEqual({ host: '192.168.1.7', port: 9101 });
    });

    test('parses IP_ prefixed Windows port', () => {
      expect(parseTcpEndpoint('IP_192.168.1.7')).toEqual({ host: '192.168.1.7', port: 9100 });
    });

    test('parses TCP_ and URI prefixed ports', () => {
      expect(parseTcpEndpoint('TCP_192.168.1.7:9100')).toEqual({ host: '192.168.1.7', port: 9100 });
      expect(parseTcpEndpoint('socket://192.168.1.7:9100')).toEqual({ host: '192.168.1.7', port: 9100 });
      expect(parseTcpEndpoint('raw://192.168.1.7')).toEqual({ host: '192.168.1.7', port: 9100 });
    });

    test('parses valid hostnames', () => {
      expect(parseTcpEndpoint('epson-printer:9100')).toEqual({ host: 'epson-printer', port: 9100 });
    });

    test('returns null for USB, WSD, or malformed ports safely', () => {
      expect(parseTcpEndpoint('USB019')).toBeNull();
      expect(parseTcpEndpoint('USB001')).toBeNull();
      expect(parseTcpEndpoint('WSD-4545-GUID')).toBeNull();
      expect(parseTcpEndpoint('')).toBeNull();
      expect(parseTcpEndpoint(null)).toBeNull();
      expect(parseTcpEndpoint('999.999.999.999')).toBeNull();
      expect(parseTcpEndpoint('192.168.1.7:999999')).toBeNull();
    });
  });

  describe('checkTcpConnectivity with mocked netModule', () => {
    test('resolves isOnline true on immediate socket connect', async () => {
      const mockSocket = {
        setTimeout: jest.fn(),
        destroy: jest.fn(),
        connect: jest.fn(),
        once: jest.fn((evt, handler) => {
          if (evt === 'connect') process.nextTick(handler);
        })
      };
      const mockNet = { Socket: jest.fn(() => mockSocket) };

      const res = await checkTcpConnectivity({ host: '192.168.1.7', port: 9100, netModule: mockNet });
      expect(res.isOnline).toBe(true);
      expect(res.error).toBeNull();
      expect(mockSocket.destroy).toHaveBeenCalled();
    });

    test('resolves isOnline false with TIMED_OUT on timeout event', async () => {
      const mockSocket = {
        setTimeout: jest.fn(),
        destroy: jest.fn(),
        connect: jest.fn(),
        once: jest.fn((evt, handler) => {
          if (evt === 'timeout') process.nextTick(handler);
        })
      };
      const mockNet = { Socket: jest.fn(() => mockSocket) };

      const res = await checkTcpConnectivity({ host: '192.168.1.7', port: 9100, netModule: mockNet });
      expect(res.isOnline).toBe(false);
      expect(res.error).toBe('TIMED_OUT');
      expect(mockSocket.destroy).toHaveBeenCalled();
    });

    test('resolves isOnline false on connection error', async () => {
      const mockSocket = {
        setTimeout: jest.fn(),
        destroy: jest.fn(),
        connect: jest.fn(),
        once: jest.fn((evt, handler) => {
          if (evt === 'error') process.nextTick(() => handler({ code: 'ECONNREFUSED' }));
        })
      };
      const mockNet = { Socket: jest.fn(() => mockSocket) };

      const res = await checkTcpConnectivity({ host: '192.168.1.7', port: 9100, netModule: mockNet });
      expect(res.isOnline).toBe(false);
      expect(res.error).toBe('ECONNREFUSED');
      expect(mockSocket.destroy).toHaveBeenCalled();
    });
  });
});
