const {
  AGENT_PROTOCOL_VERSION,
  validateAgentHello,
  getPrinterDeviceRegistry,
  validateDiscoveredPrinterInventory,
  handlePrinterAgentHello,
  handlePrinterDeviceRegistryRequest,
  handlePrinterInventoryReport,
  handlePrinterDeviceTelemetry
} = require('../src/services/printerAgentProtocol.service');

function createInventoryPrisma() {
  const tx = {
    printerDiscovery: {
      upsert: jest.fn(async ({ create }) => ({ id: 'discovery-a', ...create }))
    }
  };
  return { tx, $transaction: jest.fn(async (callback) => callback(tx)) };
}

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

  test('a malformed renegotiation clears a previously granted fleet capability', async () => {
    const socket = {
      userType: 'printer',
      machineId: 'machine-a',
      agentProtocol: { supportsMultiPrinter: true },
      emit: jest.fn()
    };
    const result = await handlePrinterAgentHello({
      socket,
      prisma: { printerDevice: { findMany: jest.fn() } },
      logger: { error: jest.fn() },
      payload: { protocolVersion: 99 }
    });

    expect(result).toEqual(expect.objectContaining({ accepted: false, code: 'UNSUPPORTED_PROTOCOL_VERSION' }));
    expect(socket.agentProtocol).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith('printer_agent_hello_ack', expect.objectContaining({
      accepted: false,
      code: 'UNSUPPORTED_PROTOCOL_VERSION'
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

describe('Printer Agent protocol — per-device telemetry isolation', () => {
  test('updates health only for a PrinterDevice owned by the authenticated Machine', async () => {
    const socket = {
      userType: 'printer',
      machineId: 'machine-a',
      agentProtocol: { supportsMultiPrinter: true }
    };
    const prisma = {
      printerDevice: {
        findFirst: jest.fn().mockResolvedValue({ id: 'device-a' }),
        update: jest.fn().mockResolvedValue({})
      }
    };
    const adminRoom = { emit: jest.fn() };
    const io = { to: jest.fn(() => adminRoom) };

    const result = await handlePrinterDeviceTelemetry({
      socket,
      io,
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: true,
        errorMessage: 'Out of Paper',
        connectionType: 'USB',
        telemetry: { portName: 'USB001' }
      }
    });

    expect(result).toEqual({
      accepted: true,
      printerDeviceId: 'device-a',
      healthStatus: 'PAPER_OUT'
    });
    expect(prisma.printerDevice.findFirst).toHaveBeenCalledWith({
      where: { id: 'device-a', machineId: 'machine-a' },
      select: { id: true }
    });
    expect(prisma.printerDevice.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'device-a' },
      data: expect.objectContaining({ healthStatus: 'PAPER_OUT', lastTelemetryAt: expect.any(Date) })
    }));
    expect(io.to).toHaveBeenCalledWith('admins');
    expect(adminRoom.emit).toHaveBeenCalledWith('printer_device_status_update', expect.objectContaining({
      machineId: 'machine-a',
      printerDeviceId: 'device-a',
      healthStatus: 'PAPER_OUT',
      telemetry: { connectionType: 'USB', portName: 'USB001' }
    }));
  });

  test('rejects a device that belongs to a different Machine and does not update or broadcast', async () => {
    const socket = {
      userType: 'printer',
      machineId: 'machine-a',
      agentProtocol: { supportsMultiPrinter: true }
    };
    const prisma = {
      printerDevice: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn()
      }
    };
    const io = { to: jest.fn() };

    const result = await handlePrinterDeviceTelemetry({
      socket,
      io,
      prisma,
      logger: { warn: jest.fn() },
      status: { printerDeviceId: 'device-owned-by-b', isError: false }
    });

    expect(result).toEqual({ accepted: false, code: 'DEVICE_MACHINE_MISMATCH' });
    expect(prisma.printerDevice.update).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
  });

  test('rejects device telemetry from an Agent without negotiated fleet capability', async () => {
    const socket = { userType: 'printer', machineId: 'machine-a' };
    const prisma = { printerDevice: { findFirst: jest.fn(), update: jest.fn() } };
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn() },
      prisma,
      logger: { warn: jest.fn() },
      status: { printerDeviceId: 'device-a', isError: false }
    });

    expect(result).toEqual({ accepted: false, code: 'AGENT_PROTOCOL_NOT_NEGOTIATED' });
    expect(prisma.printerDevice.findFirst).not.toHaveBeenCalled();
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

  test('rejects invalid inventory metadata and never forwards invalid input', async () => {
    const socket = {
      userType: 'printer',
      machineId: 'machine-a',
      machineName: 'Shop PC',
      agentProtocol: { supportsMultiPrinter: true },
      emit: jest.fn()
    };
    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };

    const result = await handlePrinterInventoryReport({
      socket,
      io,
      prisma: createInventoryPrisma(),
      logger: { warn: jest.fn() },
      payload: {
        protocolVersion: 1,
        discoveredPrinters: [{
          windowsPrinterName: 'Queue A',
          connectionType: 'UnsupportedType'
        }]
      }
    });

    expect(result).toEqual(expect.objectContaining({ accepted: false, code: 'INVALID_CONNECTION_TYPE' }));
    expect(io.to).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('printer_inventory_report_ack', expect.objectContaining({
      accepted: false,
      code: 'INVALID_CONNECTION_TYPE'
    }));
  });

  test('persists discovery then forwards inventory to Admin sockets without approving a device', async () => {
    const adminRoom = { emit: jest.fn() };
    const socket = {
      userType: 'printer',
      machineId: 'machine-a',
      machineName: 'Hyderabad Client PC',
      agentProtocol: { supportsMultiPrinter: true },
      emit: jest.fn()
    };
    const io = { to: jest.fn(() => adminRoom) };

    const prisma = createInventoryPrisma();
    const result = await handlePrinterInventoryReport({
      socket,
      io,
      prisma,
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
    expect(prisma.tx.printerDiscovery.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { machineId_queueNameKey: { machineId: 'machine-a', queueNameKey: 'epson l6460' } },
      create: expect.objectContaining({ reviewStatus: 'DISCOVERED', windowsPrinterName: 'Epson L6460' })
    }));
    expect(prisma.tx.printerDiscovery.upsert.mock.calls[0][0].update).not.toHaveProperty('reviewStatus');
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

  test('refuses inventory reports before successful multi-printer negotiation', async () => {
    const socket = {
      userType: 'printer',
      machineId: 'machine-a',
      emit: jest.fn()
    };
    const io = { to: jest.fn() };
    const result = await handlePrinterInventoryReport({
      socket,
      io,
      prisma: createInventoryPrisma(),
      logger: { warn: jest.fn() },
      payload: { protocolVersion: 1, discoveredPrinters: [] }
    });

    expect(result).toEqual(expect.objectContaining({ accepted: false, code: 'AGENT_PROTOCOL_NOT_NEGOTIATED' }));
    expect(io.to).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('printer_inventory_report_ack', expect.objectContaining({
      accepted: false,
      code: 'AGENT_PROTOCOL_NOT_NEGOTIATED'
    }));
  });

  test('refuses inventory reports from non-printer sockets', async () => {
    const socket = { userType: 'session', machineId: 'machine-a', emit: jest.fn() };
    const io = { to: jest.fn() };
    const result = await handlePrinterInventoryReport({
      socket,
      io,
      prisma: createInventoryPrisma(),
      logger: { warn: jest.fn() },
      payload: { protocolVersion: 1, discoveredPrinters: [] }
    });

    expect(result).toEqual(expect.objectContaining({ accepted: false, code: 'UNAUTHORIZED_AGENT' }));
    expect(io.to).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });
});


describe('Printer Agent protocol — authenticated registry refresh', () => {
  const requestId = 'registry_refresh_001';

  test('returns a fresh registry only to a negotiated authenticated Agent and uses socket Machine identity', async () => {
    const socket = {
      userType: 'printer',
      machineId: 'machine-authenticated',
      agentProtocol: { supportsMultiPrinter: true },
      emit: jest.fn()
    };
    const devices = [device('device-a', 'Epson L6460')];
    const prisma = {
      printerDevice: {
        findMany: jest.fn().mockResolvedValue(devices)
      }
    };

    const result = await handlePrinterDeviceRegistryRequest({
      socket,
      prisma,
      logger: { error: jest.fn() },
      requestId,
      payload: { machineId: 'attacker-machine' }
    });

    expect(result).toEqual({
      accepted: true,
      requestId,
      deviceCount: 1
    });
    expect(prisma.printerDevice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        machineId: 'machine-authenticated',
        windowsPrinterName: { not: null }
      }
    }));
    expect(socket.emit).toHaveBeenCalledWith('printer_device_registry', expect.objectContaining({
      protocolVersion: 1,
      machineId: 'machine-authenticated',
      requestId,
      devices: [expect.objectContaining({
        id: 'device-a',
        displayName: 'Epson L6460',
        windowsPrinterName: 'Epson L6460',
        status: 'ACTIVE',
        approvedAt: '2026-11-19T00:00:00.000Z',
        sortOrder: 0
      })]
    }));
  });

  test('rejects registry refresh from a non-printer socket without querying devices', async () => {
    const socket = { userType: 'admin', machineId: 'machine-a', emit: jest.fn() };
    const prisma = { printerDevice: { findMany: jest.fn() } };

    const result = await handlePrinterDeviceRegistryRequest({
      socket, prisma, logger: { error: jest.fn() }, requestId
    });

    expect(result).toEqual({ accepted: false, code: 'UNAUTHORIZED_AGENT' });
    expect(prisma.printerDevice.findMany).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  test('rejects registry refresh before successful capability negotiation', async () => {
    const socket = {
      userType: 'printer',
      machineId: 'machine-a',
      agentProtocol: { supportsMultiPrinter: false },
      emit: jest.fn()
    };
    const prisma = { printerDevice: { findMany: jest.fn() } };

    const result = await handlePrinterDeviceRegistryRequest({
      socket, prisma, logger: { error: jest.fn() }, requestId
    });

    expect(result).toEqual({ accepted: false, code: 'AGENT_PROTOCOL_NOT_NEGOTIATED' });
    expect(prisma.printerDevice.findMany).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('printer_device_registry_error', expect.objectContaining({
      requestId,
      code: 'AGENT_PROTOCOL_NOT_NEGOTIATED',
      retryable: false
    }));
  });

  test('rejects malformed request identifiers before registry access', async () => {
    const socket = {
      userType: 'printer',
      machineId: 'machine-a',
      agentProtocol: { supportsMultiPrinter: true },
      emit: jest.fn()
    };
    const prisma = { printerDevice: { findMany: jest.fn() } };

    const result = await handlePrinterDeviceRegistryRequest({
      socket, prisma, logger: { error: jest.fn() }, requestId: '../invalid'
    });

    expect(result).toEqual({ accepted: false, code: 'INVALID_REGISTRY_REQUEST_ID' });
    expect(prisma.printerDevice.findMany).not.toHaveBeenCalled();
  });

  test('fails closed and asks Agent to keep dispatch blocked when registry query fails', async () => {
    const socket = {
      userType: 'printer',
      machineId: 'machine-a',
      agentProtocol: { supportsMultiPrinter: true },
      emit: jest.fn()
    };
    const prisma = {
      printerDevice: {
        findMany: jest.fn().mockRejectedValue(new Error('database unavailable'))
      }
    };

    const result = await handlePrinterDeviceRegistryRequest({
      socket,
      prisma,
      logger: { error: jest.fn() },
      requestId
    });

    expect(result).toEqual({
      accepted: false,
      requestId,
      code: 'REGISTRY_UNAVAILABLE'
    });
    expect(socket.emit).toHaveBeenCalledWith('printer_device_registry_error', expect.objectContaining({
      requestId,
      code: 'REGISTRY_UNAVAILABLE',
      retryable: true
    }));
    expect(socket.emit.mock.calls.some(([event]) => event === 'printer_device_registry')).toBe(false);
  });
});
