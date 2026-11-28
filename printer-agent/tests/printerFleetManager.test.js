const { PrinterFleetError, PrinterFleetManager } = require('../src/printerFleetManager');
const { parseDiscoveryOutput } = require('../src/windowsPrinterDiscovery');

function discovered(name, portName = 'USB001', overrides = {}) {
  return {
    windowsPrinterName: name,
    driverName: 'Test Driver',
    portName,
    connectionType: portName.startsWith('USB') ? 'USB' : 'Network',
    printerStatus: 3,
    extendedPrinterStatus: 2,
    detectedErrorState: 0,
    extendedDetectedErrorState: 0,
    workOffline: false,
    ...overrides
  };
}

function activeDevice(id, queueName, extra = {}) {
  return {
    id,
    displayName: queueName,
    windowsPrinterName: queueName,
    status: 'ACTIVE',
    approvedAt: '2026-11-19T00:00:00.000Z',
    sortOrder: 0,
    ...extra
  };
}

describe('PrinterFleetManager', () => {
  test('creates one independent monitor per approved and discovered device', async () => {
    const monitorFactory = jest.fn(({ printerName }) => ({
      printerName,
      checkPrinterStatus: jest.fn()
    }));
    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [discovered('Epson L6460'), discovered('HP LaserJet', 'IP_192.168.1.25')],
      getDeviceRegistry: async () => [
        activeDevice('device-1', 'Epson L6460'),
        activeDevice('device-2', 'HP LaserJet')
      ],
      monitorFactory
    });

    const devices = await manager.refresh();

    expect(devices).toHaveLength(2);
    expect(devices.every((device) => device.canPrint)).toBe(true);
    expect(monitorFactory).toHaveBeenCalledTimes(2);
    expect(manager.getMonitor('device-1')).not.toBe(manager.getMonitor('device-2'));
    expect(manager.resolveForPrint('device-2')).toEqual(expect.objectContaining({
      printerDeviceId: 'device-2',
      windowsPrinterName: 'HP LaserJet'
    }));
  });

  test('discovery alone never approves or activates a printer', async () => {
    const monitorFactory = jest.fn(() => ({ checkPrinterStatus: jest.fn() }));
    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [discovered('Unapproved Queue')],
      getDeviceRegistry: async () => [{
        id: 'device-pending',
        windowsPrinterName: 'Unapproved Queue',
        status: 'PENDING_APPROVAL',
        approvedAt: null
      }],
      monitorFactory
    });

    const [device] = await manager.refresh();

    expect(device.availability).toBe('QUEUE_PRESENT');
    expect(device.canPrint).toBe(false);
    expect(device.reason).toBe('ADMIN_APPROVAL_REQUIRED');
    expect(monitorFactory).not.toHaveBeenCalled();
    expect(() => manager.resolveForPrint('device-pending')).toThrow(
      expect.objectContaining({ code: 'PRINTER_DEVICE_NOT_APPROVED_OR_AVAILABLE' })
    );
  });

  test('refuses dispatch when an approved queue has no independent health monitor', async () => {
    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [discovered('Epson L6460')],
      getDeviceRegistry: async () => [activeDevice('device-1', 'Epson L6460')]
    });

    const [device] = await manager.refresh();
    expect(device.canPrint).toBe(false);
    expect(device.reason).toBe('DEVICE_MONITOR_UNAVAILABLE');
    expect(() => manager.resolveForPrint('device-1')).toThrow();
  });

  test('does not route an approved device when its exact queue is absent or renamed', async () => {
    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [discovered('Epson L6460 (Copy 1)')],
      getDeviceRegistry: async () => [activeDevice('device-1', 'Epson L6460')]
    });

    const [device] = await manager.refresh();
    expect(device.canPrint).toBe(false);
    expect(device.reason).toBe('WINDOWS_QUEUE_NOT_PRESENT');
    expect(() => manager.resolveForPrint('device-1')).toThrow();
  });

  test('a missing approval timestamp fails closed even when status says ACTIVE', async () => {
    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [discovered('Epson L6460')],
      getDeviceRegistry: async () => [{
        id: 'device-1',
        windowsPrinterName: 'Epson L6460',
        status: 'ACTIVE',
        approvedAt: null
      }],
      monitorFactory: () => ({ checkPrinterStatus: jest.fn() })
    });

    const [device] = await manager.refresh();
    expect(device.canPrint).toBe(false);
    expect(device.reason).toBe('APPROVAL_EVIDENCE_MISSING');
  });

  test('an unavailable device does not suppress another available device', async () => {
    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [discovered('Online Queue')],
      getDeviceRegistry: async () => [
        activeDevice('device-online', 'Online Queue'),
        activeDevice('device-missing', 'Missing Queue')
      ],
      monitorFactory: ({ printerName }) => ({ printerName, checkPrinterStatus: jest.fn() })
    });

    const devices = await manager.refresh();
    expect(devices.find((device) => device.id === 'device-online').canPrint).toBe(true);
    expect(devices.find((device) => device.id === 'device-missing').canPrint).toBe(false);
    expect(manager.resolveForPrint('device-online').windowsPrinterName).toBe('Online Queue');
  });

  test('blocks dispatch eligibility when printer is marked WorkOffline or has error state', async () => {
    const offlinePrinter = {
      ...discovered('Offline Printer'),
      workOffline: true
    };
    const errorPrinter = {
      ...discovered('Error Printer'),
      detectedErrorState: 4
    };
    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [offlinePrinter, errorPrinter],
      getDeviceRegistry: async () => [
        activeDevice('device-offline', 'Offline Printer'),
        activeDevice('device-error', 'Error Printer')
      ],
      monitorFactory: () => ({ checkPrinterStatus: jest.fn() })
    });

    const devices = await manager.refresh();
    const offlineDev = devices.find((d) => d.id === 'device-offline');
    const errorDev = devices.find((d) => d.id === 'device-error');

    expect(offlineDev.canPrint).toBe(false);
    expect(offlineDev.reason).toBe('PRINTER_OFFLINE');
    expect(errorDev.canPrint).toBe(false);
    expect(errorDev.reason).toBe('PRINTER_ERROR_STATE');
    expect(() => manager.resolveForPrint('device-offline')).toThrow();
    expect(() => manager.resolveForPrint('device-error')).toThrow();
  });

  test('keeps healthy printer with DetectedErrorState 2 (No Error) eligible to print', async () => {
    const healthyPrinter = {
      ...discovered('Healthy Printer'),
      detectedErrorState: 2,
      extendedDetectedErrorState: 2
    };
    const lowPaperPrinter = {
      ...discovered('Low Paper Printer'),
      detectedErrorState: 3
    };
    const lowTonerPrinter = {
      ...discovered('Low Toner Printer'),
      detectedErrorState: 5
    };

    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [healthyPrinter, lowPaperPrinter, lowTonerPrinter],
      getDeviceRegistry: async () => [
        activeDevice('dev-healthy', 'Healthy Printer'),
        activeDevice('dev-low-paper', 'Low Paper Printer'),
        activeDevice('dev-low-toner', 'Low Toner Printer')
      ],
      monitorFactory: () => ({ checkPrinterStatus: jest.fn() })
    });

    const devices = await manager.refresh();
    const devHealthy = devices.find((d) => d.id === 'dev-healthy');
    const devLowPaper = devices.find((d) => d.id === 'dev-low-paper');
    const devLowToner = devices.find((d) => d.id === 'dev-low-toner');

    expect(devHealthy.canPrint).toBe(true);
    expect(devHealthy.reason).toBeNull();

    expect(devLowPaper.canPrint).toBe(true);
    expect(devLowPaper.reason).toBeNull();

    expect(devLowToner.canPrint).toBe(true);
    expect(devLowToner.reason).toBeNull();

    expect(manager.resolveForPrint('dev-healthy')).toBeDefined();
    expect(manager.resolveForPrint('dev-low-paper')).toBeDefined();
    expect(manager.resolveForPrint('dev-low-toner')).toBeDefined();
  });

  test('correctly resolves three real Windows printer payload shapes (Epson, HP, Canon)', async () => {
    const epson = discovered('EPSON L6460 Series', '192.168.1.7');
    const hp = discovered('HP LaserJet Professional M1136 MFP', 'USB011');
    const canon = discovered('Canon Generic Plus UFR II', 'USB001');

    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [epson, hp, canon],
      getDeviceRegistry: async () => [
        activeDevice('dev-epson', 'EPSON L6460 Series'),
        activeDevice('dev-hp', 'HP LaserJet Professional M1136 MFP'),
        activeDevice('dev-canon', 'Canon Generic Plus UFR II')
      ],
      monitorFactory: () => ({ checkPrinterStatus: jest.fn() })
    });

    const devices = await manager.refresh();
    expect(devices).toHaveLength(3);
    expect(devices.every((d) => d.canPrint)).toBe(true);
    expect(devices.every((d) => d.reason === null)).toBe(true);
  });

  test('refuses dispatch eligibility on uncorroborated DetectedErrorState 0 (missing status)', async () => {
    const uncorroboratedPrinter = {
      windowsPrinterName: 'Uncorroborated',
      detectedErrorState: 0
    };

    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [uncorroboratedPrinter],
      getDeviceRegistry: async () => [activeDevice('dev-uncorroborated', 'Uncorroborated')],
      monitorFactory: () => ({ checkPrinterStatus: jest.fn() })
    });

    const [device] = await manager.refresh();
    expect(device.canPrint).toBe(false);
    expect(device.reason).toBe('PRINTER_ERROR_STATE');
    expect(() => manager.resolveForPrint('dev-uncorroborated')).toThrow();
  });

  test('refuses dispatch eligibility when printer is busy (PrinterStatus 4)', async () => {
    const busyPrinter = discovered('Busy Printer', 'USB001', { printerStatus: 4 });

    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [busyPrinter],
      getDeviceRegistry: async () => [activeDevice('dev-busy', 'Busy Printer')],
      monitorFactory: () => ({ checkPrinterStatus: jest.fn() })
    });

    const [device] = await manager.refresh();
    expect(device.canPrint).toBe(false);
    expect(device.reason).toBe('PRINTER_BUSY');
    expect(() => manager.resolveForPrint('dev-busy')).toThrow();
  });

  test('rejects duplicate registered queue bindings and more than ten devices', async () => {
    const duplicateManager = new PrinterFleetManager({
      discoverPrinters: async () => [discovered('Queue A')],
      getDeviceRegistry: async () => [
        activeDevice('device-1', 'Queue A'),
        activeDevice('device-2', 'Queue A')
      ]
    });
    await expect(duplicateManager.refresh()).rejects.toEqual(
      expect.objectContaining({ code: 'DUPLICATE_APPROVED_QUEUE' })
    );

    const oversizedManager = new PrinterFleetManager({
      discoverPrinters: async () => [],
      getDeviceRegistry: async () => Array.from({ length: 11 }, (_, i) => ({
        id: `device-${i}`, status: 'PENDING_APPROVAL', windowsPrinterName: null
      }))
    });
    await expect(oversizedManager.refresh()).rejects.toEqual(
      expect.objectContaining({ code: 'FLEET_LIMIT_EXCEEDED' })
    );
  });

  test('clears old routing and monitor state when a refresh fails', async () => {
    let failDiscovery = false;
    const manager = new PrinterFleetManager({
      discoverPrinters: async () => {
        if (failDiscovery) throw new Error('PowerShell unavailable');
        return [discovered('Epson L6460')];
      },
      getDeviceRegistry: async () => [activeDevice('device-1', 'Epson L6460')],
      monitorFactory: () => ({ checkPrinterStatus: jest.fn() })
    });

    await manager.refresh();
    expect(manager.resolveForPrint('device-1')).toBeDefined();

    failDiscovery = true;
    await expect(manager.refresh()).rejects.toThrow('PowerShell unavailable');
    expect(manager.getMonitor('device-1')).toBeNull();
    expect(() => manager.resolveForPrint('device-1')).toThrow();
  });

  test('checks each monitor independently and returns the number of checks started', async () => {
    const monitorA = { checkPrinterStatus: jest.fn() };
    const monitorB = { checkPrinterStatus: jest.fn() };
    const monitors = [monitorA, monitorB];
    const manager = new PrinterFleetManager({
      discoverPrinters: async () => [discovered('A'), discovered('B', 'IP_10.0.0.2')],
      getDeviceRegistry: async () => [activeDevice('device-a', 'A'), activeDevice('device-b', 'B')],
      monitorFactory: () => monitors.shift()
    });

    await manager.refresh();
    const socket = { emit: jest.fn() };

    expect(manager.checkPrinterStatuses(socket)).toBe(2);
    expect(monitorA.checkPrinterStatus).toHaveBeenCalledWith(socket);
    expect(monitorB.checkPrinterStatus).toHaveBeenCalledWith(socket);
  });

  test('end-to-end integration: chained raw Windows discovery JSON -> normalization -> fleet readiness', async () => {
    // 1. Representative raw Windows CIM JSON payload containing Epson, HP, Canon, and negative edge cases
    const rawWindowsCimJson = JSON.stringify([
      {
        Name: 'EPSON L6460 Series',
        DriverName: 'EPSON L6460 Series',
        PortName: 'USB001',
        PrinterStatus: 3,
        ExtendedPrinterStatus: 2,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: 0,
        WorkOffline: false
      },
      {
        Name: 'HP LaserJet Professional M1136 MFP',
        DriverName: 'HP LaserJet Professional M1136 MFP',
        PortName: 'DOT4_001',
        PrinterStatus: 3,
        ExtendedPrinterStatus: 2,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: 0,
        WorkOffline: false
      },
      {
        Name: 'Canon Generic Plus UFR II',
        DriverName: 'Canon Generic Plus UFR II',
        PortName: 'WSD-1234',
        PrinterStatus: 3,
        ExtendedPrinterStatus: 2,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: 0,
        WorkOffline: false
      },
      {
        // Uncorroborated DetectedErrorState 0 (PrinterStatus missing/null or not 3)
        Name: 'Uncorroborated Code 0 Printer',
        DriverName: 'Generic Driver',
        PortName: 'USB002',
        PrinterStatus: null,
        ExtendedPrinterStatus: 2,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: 0,
        WorkOffline: false
      },
      {
        // Missing Extended Telemetry
        Name: 'Legacy Truncated Printer',
        DriverName: 'Generic Driver',
        PortName: 'USB003',
        PrinterStatus: 3,
        ExtendedPrinterStatus: null,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: null,
        WorkOffline: false
      },
      {
        // Offline Printer
        Name: 'Offline Epson Queue',
        DriverName: 'EPSON L6460 Series',
        PortName: 'USB004',
        PrinterStatus: 7,
        ExtendedPrinterStatus: 7,
        DetectedErrorState: 0,
        ExtendedDetectedErrorState: 0,
        WorkOffline: true
      },
      {
        // Genuine Error Printer (Paper Jam = 4)
        Name: 'Jammed HP Queue',
        DriverName: 'HP LaserJet Professional M1136 MFP',
        PortName: 'DOT4_002',
        PrinterStatus: 3,
        ExtendedPrinterStatus: 2,
        DetectedErrorState: 4,
        ExtendedDetectedErrorState: 0,
        WorkOffline: false
      }
    ]);

    // 2 & 3. Parse raw JSON and normalize records via parseDiscoveryOutput
    const parsedDiscoveredPrinters = parseDiscoveryOutput(rawWindowsCimJson);
    expect(parsedDiscoveredPrinters).toHaveLength(7);

    // Verify normalization preserved extended fields
    const epsonRecord = parsedDiscoveredPrinters.find((p) => p.windowsPrinterName === 'EPSON L6460 Series');
    expect(epsonRecord).toMatchObject({
      printerStatus: 3,
      extendedPrinterStatus: 2,
      detectedErrorState: 0,
      extendedDetectedErrorState: 0,
      workOffline: false
    });

    // 4. Feed into PrinterFleetManager
    const monitorFactory = jest.fn(({ printerName }) => ({
      printerName,
      checkPrinterStatus: jest.fn()
    }));

    const registeredDevices = [
      activeDevice('dev-epson', 'EPSON L6460 Series'),
      activeDevice('dev-hp', 'HP LaserJet Professional M1136 MFP'),
      activeDevice('dev-canon', 'Canon Generic Plus UFR II'),
      activeDevice('dev-uncorroborated', 'Uncorroborated Code 0 Printer'),
      activeDevice('dev-missing-extended', 'Legacy Truncated Printer'),
      activeDevice('dev-offline', 'Offline Epson Queue'),
      activeDevice('dev-jammed', 'Jammed HP Queue'),
      activeDevice('dev-unmatched', 'Completely Mismatched Queue Name')
    ];

    const manager = new PrinterFleetManager({
      discoverPrinters: async () => parsedDiscoveredPrinters,
      getDeviceRegistry: async () => registeredDevices,
      monitorFactory
    });

    // 5. Refresh fleet
    const fleetDevices = await manager.refresh();
    expect(fleetDevices).toHaveLength(8);

    // 6. Assert readiness via resolveForPrint and device properties

    // Healthy-idle corroborated telemetry -> canPrint === true
    expect(fleetDevices.find((d) => d.id === 'dev-epson').canPrint).toBe(true);
    expect(fleetDevices.find((d) => d.id === 'dev-hp').canPrint).toBe(true);
    expect(fleetDevices.find((d) => d.id === 'dev-canon').canPrint).toBe(true);

    const resolvedEpson = manager.resolveForPrint('dev-epson');
    expect(resolvedEpson.windowsPrinterName).toBe('EPSON L6460 Series');

    const resolvedHp = manager.resolveForPrint('dev-hp');
    expect(resolvedHp.windowsPrinterName).toBe('HP LaserJet Professional M1136 MFP');

    const resolvedCanon = manager.resolveForPrint('dev-canon');
    expect(resolvedCanon.windowsPrinterName).toBe('Canon Generic Plus UFR II');

    // DetectedErrorState = 0 alone (uncorroborated) -> canPrint === false
    const uncorroboratedDev = fleetDevices.find((d) => d.id === 'dev-uncorroborated');
    expect(uncorroboratedDev.canPrint).toBe(false);
    expect(uncorroboratedDev.reason).toBe('PRINTER_ERROR_STATE');
    expect(() => manager.resolveForPrint('dev-uncorroborated')).toThrow(
      expect.objectContaining({ code: 'PRINTER_DEVICE_NOT_APPROVED_OR_AVAILABLE' })
    );

    // Missing Extended telemetry -> canPrint === false
    const missingExtendedDev = fleetDevices.find((d) => d.id === 'dev-missing-extended');
    expect(missingExtendedDev.canPrint).toBe(false);
    expect(missingExtendedDev.reason).toBe('PRINTER_ERROR_STATE');
    expect(() => manager.resolveForPrint('dev-missing-extended')).toThrow(
      expect.objectContaining({ code: 'PRINTER_DEVICE_NOT_APPROVED_OR_AVAILABLE' })
    );

    // Offline state -> canPrint === false
    const offlineDev = fleetDevices.find((d) => d.id === 'dev-offline');
    expect(offlineDev.canPrint).toBe(false);
    expect(offlineDev.reason).toBe('PRINTER_OFFLINE');
    expect(() => manager.resolveForPrint('dev-offline')).toThrow(
      expect.objectContaining({ code: 'PRINTER_DEVICE_NOT_APPROVED_OR_AVAILABLE' })
    );

    // Genuine error state (Paper Jam) -> canPrint === false
    const jammedDev = fleetDevices.find((d) => d.id === 'dev-jammed');
    expect(jammedDev.canPrint).toBe(false);
    expect(jammedDev.reason).toBe('PRINTER_ERROR_STATE');
    expect(() => manager.resolveForPrint('dev-jammed')).toThrow(
      expect.objectContaining({ code: 'PRINTER_DEVICE_NOT_APPROVED_OR_AVAILABLE' })
    );

    // Mismatched queue name -> does not adopt other printers' readiness
    const unmatchedDev = fleetDevices.find((d) => d.id === 'dev-unmatched');
    expect(unmatchedDev.canPrint).toBe(false);
    expect(unmatchedDev.reason).toBe('WINDOWS_QUEUE_NOT_PRESENT');
    expect(() => manager.resolveForPrint('dev-unmatched')).toThrow(
      expect.objectContaining({ code: 'PRINTER_DEVICE_NOT_APPROVED_OR_AVAILABLE' })
    );
  });
});
