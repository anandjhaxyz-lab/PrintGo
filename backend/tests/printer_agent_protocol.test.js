const {
  AGENT_PROTOCOL_VERSION,
  validateAgentHello,
  getPrinterDeviceRegistry,
  validateDiscoveredPrinterInventory,
  handlePrinterAgentHello,
  handlePrinterInventoryReport
} = require('../src/services/printerAgentProtocol.service');

function windowsHello(overrides = {}) {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentVersion: '1.0.0',
    installationId: 'stable-installation-id',
    journalSchemaVersion: 2,
    host: {
      platform: 'win32',
      arch: 'x64',
      release: '10.0.22631'
    },
    capabilities: {
      multiPrinter: true,
      printerDiscovery: true,
      maxPrinters: 10
    },
    ...overrides
  };
}

function device(id, queueName, extra = {}) {
  return {
    id,
    displayName: queueName,
    windowsPrinterName: queueName,
    status: 'ACTIVE',
    approvedAt: new Date('2026-11-19T00:00:00.000Z'),
    sortOrder: 0,
    ...extra
  };
}

describe('Printer Agent protocol — negotiation and machine isolation', () => {
  test('accepts supported Windows x64 capability and returns bounded capability data', () => {
    expect(validateAgentHello(windowsHello())).toEqual(expect.objectContaining({
      accepted: true,
      protocolVersion: 1,
      supportsMultiPrinter: true,
      maxPrinters: 10,
      journalSchemaVersion: 2
    }));
  });

  test('keeps unsupported operating systems on legacy single-printer mode', () => {
    const linux = windowsHello({
      host: { platform: 'linux', arch: 'x64', release: '6.8.0' }
    });
    expect(validateAgentHello(linux)).toEqual(expect.objectContaining({
      accepted: true,
      supportsMultiPrinter: false,
      maxPrinters: 1
    }));
  });

  test('rejects unsupported protocol and journal versions', () => {
    expect(validateAgentHello(windowsHello({ protocolVersion: 99 }))).toEqual(
      expect.objectContaining({ accepted: false, code: 'UNSUPPORTED_PROTOCOL_VERSION' })
    );
    expect(validateAgentHello(windowsHello({ journalSchemaVersion: 99 }))).toEqual(
      expect.objectContaining({ accepted: false, code: 'UNSUPPORTED_JOURNAL_SCHEMA' })
    );
  });

  test('builds registry queries from authenticated machineId, not payload-supplied identity', async () => {
    const prisma = {
      printerDevice: {
        findMany: jest.fn().mockResolvedValue([
          device('device-1', 'Epson L6460'),
          device('device-2', 'HP LaserJet', {
            status: 'PENDING_APPROVAL',
            approvedAt: null,
            sortOrder: 2
          }),
          device('legacy-placeholder', '', { windowsPrinterName: null })
        ])
      }
    };
    const socket = {
      userType: 'printer',
      machineId: 'machine-authenticated-a',
      emit: jest.fn()
    };

    const result = await handlePrinterAgentHello({
      socket,
      prisma,
      logger: { error: jest.fn() },
      payload: {
        ...windowsHello(),
        machineId: 'machine-attacker-b'
      }
    });

    expect(result).toEqual(expect.objectContaining({ accepted: true, supportsMultiPrinter: true, deviceCount: 2 }));
    expect(prisma.printerDevice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        machineId: 'machine-authenticated-a',
        windowsPrinterName: { not: null }
      }
    }));

    const registryEvent = socket.emit.mock.calls.find(([event]) => event === 'printer_device_registry');
    expect(registryEvent[1]).toEqual(expect.objectContaining({
      machineId: 'machine-authenticated-a',
      protocolVersion: 1
    }));
    expect(registryEvent[1].devices.map(item => item.id)).toEqual(['device-1', 'device-2']);
    expect(registryEvent[1].devices[1].status).toBe('PENDING_APPROVAL');

    // The authenticated registry response includes only an allowlisted DTO, not
    // Machine Key, E2EE keys, company metadata or arbitrary Prisma columns.
    expect(registryEvent[1].devices[0]).toEqual(expect.objectContaining({
      id: 'device-1',
      windowsPrinterName: 'Epson L6460'
    }));
    expect(registryEvent[1].devices[0].machineKey).toBeUndefined();
    expect(registryEvent[1].devices[0].publicKey).toBeUndefined();
  });

  test('does not return a fleet registry to non-printer sockets', async () => {
    const socket = { userType: 'session', machineId: 'machine-a', emit: jest.fn() };
    const prisma = { printerDevice: { findMany: jest.fn() } };
    const result = await handlePrinterAgentHello({
      socket,
      prisma,
      logger: { error: jest.fn() },
      payload: windowsHello()
    });

    expect(result).toEqual(expect.objectContaining({ accepted: false, code: 'UNAUTHORIZED_AGENT' }));
    expect(prisma.printerDevice.findMany).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('does not send a registry when capabilities are not supported', async () => {
    const socket = { userType: 'printer', machineId: 'machine-a', emit: jest.fn() };
    const prisma = { printerDevice: { findMany: jest.fn() } };
    const result = await handlePrinterAgentHello({
      socket,
      prisma,
      logger: { error: jest.fn() },
      payload: windowsHello({ host: { platform: 'win32', arch: 'arm64', release: '10.0' } })
    });

    expect(result).toEqual({ accepted: true, supportsMultiPrinter: false });
    expect(prisma.printerDevice.findMany).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('printer_agent_hello_ack', expect.objectContaining({
      accepted: true,
      supportsMultiPrinter: false
    }));
  });

  test('fails closed when more than ten queue-bound devices are registered', async () => {
    const prisma = {
      printerDevice: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: 11 }, (_, i) => device(`d${i}`, `Queue ${i}`))
        )
      }
    };
    await expect(getPrinterDeviceRegistry(prisma, 'machine-a'))
      .rejects.toEqual(expect.objectContaining({ code: 'FLEET_LIMIT_EXCEEDED' }));
  });
});

describe('Printer Agent protocol — inventory report', () => {
  test('normalizes queue inventory and keeps duplicate queue names out', () => {
    const inventory = validateDiscoveredPrinterInventory({
      protocolVersion: 1,
      discoveredPrinters: [{
        windowsPrinterName: 'Epson L6460',
        driverName: 'Epson ESC/P-R V4',
        portName: 'USB001',
        connectionType: 'USB',
        printerStatus: 3,
        detectedErrorState: 0,
        workOffline: false,
        shared: false,
        network: false,
        isDefault: true,
        untrustedExtraField: 'discard me'
      }]
    });

    expect(inventory).toEqual([{
      windowsPrinterName: 'Epson L6460',
      driverName: 'Epson ESC/P-R V4',
      portName: 'USB001',
      connectionType: 'USB',
      printerStatus: 3,
      detectedErrorState: 0,
      workOffline: false,
      shared: false,
      network: false,
      isDefault: true
    }]);

    expect(() => validateDiscoveredPrinterInventory({
      protocolVersion: 1,
      discoveredPrinters: [
        { windowsPrinterName: 'Queue A' },
        { windowsPrinterName: 'queue a' }
      ]
    })).toThrow(expect.objectContaining({ code: 'DUPLICATE_DISCOVERED_QUEUE' }));
  });

  test('rejects unsafe inventory payloads and never forwards invalid input', () => {
    const socket = {
      userType: 'printer',
      machineId: 'machine-a',
      machineName: 'Shop PC',
      emit: jest.fn()
    };
    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };

    const result = handlePrinterInventoryReport({
      socket,
      io,
      logger: { warn: jest.fn() },
      payload: {
        protocolVersion: 1,
        discoveredPrinters: [{
          windowsPrinterName: "Queue'; Remove-Printer *",
          connectionType: 'USB'
        }]
      }
    });

    expect(result.accepted).toBe(false);
    expect(io.to).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('printer_inventory_report_ack', expect.objectContaining({
      accepted: false
    }));
  });

  test('forwards valid inventory only to Admin sockets and does not create/approve devices', () => {
    const adminRoom = { emit: jest.fn() };
    const socket = {
      userType: 'printer',
      machineId: 'machine-a',
      machineName: 'Hyderabad Client PC',
      agentProtocol: { supportsMultiPrinter: true },
      emit: jest.fn()
    };
    const io = { to: jest.fn(() => adminRoom) };

    const result = handlePrinterInventoryReport({
      socket,
      io,
      logger: { warn: jest.fn() },
      payload: {
        protocolVersion: 1,
        discoveredPrinters: [{
          windowsPrinterName: 'Epson L6460',
          driverName: 'Epson Driver',
          portName: 'USB001',
          connectionType: 'USB'
        }]
      }
    });

    expect(result).toEqual({ accepted: true, receivedCount: 1 });
    expect(io.to).toHaveBeenCalledWith('admins');
    expect(adminRoom.emit).toHaveBeenCalledWith('printer_inventory_report', expect.objectContaining({
      machineId: 'machine-a',
      machineName: 'Hyderabad Client PC',
      discoveredPrinters: [expect.objectContaining({ windowsPrinterName: 'Epson L6460' })]
    }));
    expect(socket.emit).toHaveBeenCalledWith('printer_inventory_report_ack', expect.objectContaining({
      accepted: true,
      receivedCount: 1
    }));
  });

  test('refuses inventory reports from non-printer sockets', () => {
    const socket = { userType: 'session', machineId: 'machine-a', emit: jest.fn() };
    const io = { to: jest.fn() };
    const result = handlePrinterInventoryReport({
      socket,
      io,
      logger: { warn: jest.fn() },
      payload: { protocolVersion: 1, discoveredPrinters: [] }
    });

    expect(result).toEqual(expect.objectContaining({ accepted: false, code: 'UNAUTHORIZED_AGENT' }));
    expect(io.to).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
