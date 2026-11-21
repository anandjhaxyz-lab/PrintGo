const { PrinterFleetError, PrinterFleetManager } = require('../src/printerFleetManager');

function discovered(name, portName = 'USB001') {
  return {
    windowsPrinterName: name,
    driverName: 'Test Driver',
    portName,
    connectionType: portName.startsWith('USB') ? 'USB' : 'Network'
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
      getDeviceRegistry: async () => [activeDevice('device-1', 'Epson L6460', { approvedAt: null })]
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
      detectedErrorState: 2
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
});
