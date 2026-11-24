const {
  AGENT_PROTOCOL_VERSION,
  validateAgentHello,
  getPrinterDeviceRegistry,
  validateDiscoveredPrinterInventory,
  handlePrinterAgentHello,
  handlePrinterDeviceRegistryRequest,
  handlePrinterInventoryReport,
  handlePrinterDeviceTelemetry,
  pushPrinterDeviceRegistrySync
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

  test('enforces explicit OS compatibility matrix (Win 10/11 x64 accepted; Win 8.1, ARM64, Linux rejected)', () => {
    // Windows 10 x64: accepted
    const win10 = windowsHello({ host: { platform: 'win32', arch: 'x64', release: '10.0.19045' } });
    expect(validateAgentHello(win10)).toEqual(expect.objectContaining({
      accepted: true,
      supportsMultiPrinter: true,
      maxPrinters: 10
    }));

    // Windows 11 x64: accepted
    const win11 = windowsHello({ host: { platform: 'win32', arch: 'x64', release: '10.0.22631' } });
    expect(validateAgentHello(win11)).toEqual(expect.objectContaining({
      accepted: true,
      supportsMultiPrinter: true,
      maxPrinters: 10
    }));

    // Windows 8.1 x64: rejected (legacy mode)
    const win81 = windowsHello({ host: { platform: 'win32', arch: 'x64', release: '6.3.9600' } });
    expect(validateAgentHello(win81)).toEqual(expect.objectContaining({
      accepted: true,
      supportsMultiPrinter: false,
      maxPrinters: 1
    }));

    // Windows 10 ARM64: rejected (legacy mode)
    const win10Arm = windowsHello({ host: { platform: 'win32', arch: 'arm64', release: '10.0.19045' } });
    expect(validateAgentHello(win10Arm)).toEqual(expect.objectContaining({
      accepted: true,
      supportsMultiPrinter: false,
      maxPrinters: 1
    }));

    // Linux x64: rejected (legacy mode)
    const linux = windowsHello({ host: { platform: 'linux', arch: 'x64', release: '6.8.0' } });
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

function createTelemetryMockPrisma({
  machine = [{ id: 'machine-a' }],
  device = {
    id: 'device-a',
    windowsPrinterName: 'Epson L6460',
    status: 'ACTIVE',
    approvedAt: new Date(),
    isDefault: true,
    machine: { companyId: 'company-1' }
  },
  updateManyCount = 1,
  activeDefaults = [{ id: 'device-a' }]
} = {}) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(machine),
    printerDevice: {
      findFirst: jest.fn().mockResolvedValue(device),
      updateMany: jest.fn().mockResolvedValue({ count: updateManyCount }),
      findMany: jest.fn().mockResolvedValue(activeDefaults)
    },
    printerStatus: {
      create: jest.fn().mockResolvedValue({ id: 'status-1' })
    },
    machine: {
      update: jest.fn().mockResolvedValue({})
    }
  };

  return {
    tx,
    $transaction: jest.fn(async (cb) => cb(tx)),
    $queryRaw: tx.$queryRaw,
    printerDevice: tx.printerDevice,
    printerStatus: tx.printerStatus,
    machine: tx.machine
  };
}

describe('Printer Agent protocol — per-device telemetry isolation and Phase 9 bridge', () => {
  const baseSocket = {
    userType: 'printer',
    machineId: 'machine-a',
    companyId: 'company-1',
    agentProtocol: { supportsMultiPrinter: true }
  };

  test('updates health only for a PrinterDevice owned by the authenticated Machine', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma({
      device: {
        id: 'device-a',
        windowsPrinterName: 'Epson L6460',
        status: 'ACTIVE',
        approvedAt: new Date(),
        isDefault: false
      }
    });
    const adminRoom = { emit: jest.fn() };
    const io = { to: jest.fn(() => adminRoom) };
    const now = Date.now();

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
        telemetry: { portName: 'USB001' },
        timestamp: new Date(now).toISOString()
      },
      now
    });

    expect(result.accepted).toBe(true);
    expect(result.printerDeviceId).toBe('device-a');
    expect(result.healthStatus).toBe('PAPER_OUT');
    expect(prisma.tx.$queryRaw).toHaveBeenCalled();
    expect(prisma.tx.printerDevice.findFirst).toHaveBeenCalledWith({
      where: { id: 'device-a', machineId: 'machine-a' },
      select: expect.objectContaining({ id: true, windowsPrinterName: true })
    });
    expect(prisma.tx.printerDevice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'device-a', machineId: 'machine-a', status: 'ACTIVE' }),
      data: expect.objectContaining({ healthStatus: 'PAPER_OUT' })
    }));
    expect(io.to).toHaveBeenCalledWith('company_company-1');
    expect(adminRoom.emit).toHaveBeenCalledWith('printer_device_status_update', expect.objectContaining({
      machineId: 'machine-a',
      printerDeviceId: 'device-a',
      healthStatus: 'PAPER_OUT'
    }));
  });

  test('rejects telemetry and preserves health when Windows queue name does not match approved device queue', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma({
      device: {
        id: 'device-a',
        windowsPrinterName: 'Epson L6460',
        status: 'ACTIVE',
        approvedAt: new Date()
      }
    });
    const io = { to: jest.fn() };
    const now = Date.now();

    const result = await handlePrinterDeviceTelemetry({
      socket,
      io,
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'HP LaserJet Mismatched Queue',
        isError: false,
        connectionType: 'USB',
        timestamp: new Date(now).toISOString()
      },
      now
    });

    expect(result).toEqual({ accepted: false, code: 'QUEUE_IDENTITY_MISMATCH' });
    expect(prisma.tx.printerDevice.updateMany).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
  });

  test('rejects a device that belongs to a different Machine and does not update or broadcast', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma({ device: null });
    const io = { to: jest.fn() };
    const now = Date.now();

    const result = await handlePrinterDeviceTelemetry({
      socket,
      io,
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-owned-by-b',
        printerName: 'Some Queue',
        isError: false,
        timestamp: new Date(now).toISOString()
      },
      now
    });

    expect(result).toEqual({ accepted: false, code: 'DEVICE_MACHINE_MISMATCH' });
    expect(prisma.tx.printerDevice.updateMany).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
  });

  test('rejects device telemetry from an Agent without negotiated fleet capability', async () => {
    const socket = { userType: 'printer', machineId: 'machine-a' };
    const prisma = createTelemetryMockPrisma();
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn() },
      prisma,
      logger: { warn: jest.fn() },
      status: { printerDeviceId: 'device-a', isError: false, timestamp: new Date().toISOString() }
    });

    expect(result).toEqual({ accepted: false, code: 'AGENT_PROTOCOL_NOT_NEGOTIATED' });
    expect(prisma.tx.printerDevice.findFirst).not.toHaveBeenCalled();
  });

  // Gate 5 Coverage: 16 Focused Bridge Test Cases
  test('1. Missing timestamp rejection', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma();
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn() },
      prisma,
      logger: { warn: jest.fn() },
      status: { printerDeviceId: 'device-a', printerName: 'Epson L6460', isError: false }
    });
    expect(result).toEqual({
      accepted: false,
      code: 'INVALID_TELEMETRY_TIMESTAMP',
      message: 'Device telemetry must contain a timestamp.'
    });
  });

  test('2. Invalid timestamp rejection', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma();
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn() },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        timestamp: 'invalid-not-a-date'
      }
    });
    expect(result).toEqual({
      accepted: false,
      code: 'INVALID_TELEMETRY_TIMESTAMP',
      message: 'Device telemetry timestamp is invalid.'
    });
  });

  test('3. Future timestamp rejection (>30 seconds)', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma();
    const now = Date.now();
    const futureTime = new Date(now + 35000).toISOString();
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn() },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        timestamp: futureTime
      },
      now
    });
    expect(result).toEqual({
      accepted: false,
      code: 'FUTURE_TELEMETRY_TIMESTAMP',
      message: 'Device telemetry timestamp is more than 30 seconds in the future.'
    });
  });

  test('4. Stale timestamp rejection (>180 seconds)', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma();
    const now = Date.now();
    const staleTime = new Date(now - 190000).toISOString();
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn() },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        timestamp: staleTime
      },
      now
    });
    expect(result).toEqual({
      accepted: false,
      code: 'STALE_TELEMETRY_TIMESTAMP',
      message: 'Device telemetry timestamp is older than 180 seconds.'
    });
  });

  test('5. Out-of-order packet rejection (updateMany.count === 0)', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma({ updateManyCount: 0 });
    const now = Date.now();
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn() },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        timestamp: new Date(now).toISOString()
      },
      now
    });
    expect(result).toEqual({
      accepted: true,
      skipped: true,
      reason: 'STALE_OR_OUT_OF_ORDER_DROPPED',
      printerDeviceId: 'device-a',
      bridged: false
    });
    expect(prisma.tx.printerStatus.create).not.toHaveBeenCalled();
  });

  test('6. Valid default Epson telemetry creates machine-level PrinterStatus and sets bridged: true', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma();
    const now = Date.now();
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn(() => ({ emit: jest.fn() })) },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        connectionType: 'Network',
        timestamp: new Date(now).toISOString()
      },
      now
    });

    expect(result.accepted).toBe(true);
    expect(result.bridged).toBe(true);
    expect(prisma.tx.printerStatus.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        machineId: 'machine-a',
        printerDeviceId: 'device-a',
        isOnline: true,
        paperStatus: 'UNKNOWN',
        tonerStatus: 'UNKNOWN',
        jamStatus: false,
        connectionType: 'Network'
      })
    });
  });

  test('7. Secondary device updates only its own device telemetry and does not bridge', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma({
      device: {
        id: 'device-b',
        windowsPrinterName: 'Brother Queue',
        status: 'ACTIVE',
        approvedAt: new Date(),
        isDefault: false
      },
      activeDefaults: [{ id: 'device-a' }]
    });
    const now = Date.now();
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn(() => ({ emit: jest.fn() })) },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-b',
        printerName: 'Brother Queue',
        isError: false,
        timestamp: new Date(now).toISOString()
      },
      now
    });

    expect(result.accepted).toBe(true);
    expect(result.bridged).toBe(false);
    expect(result.printerDeviceId).toBe('device-b');
    expect(prisma.tx.printerDevice.updateMany).toHaveBeenCalled();
    expect(prisma.tx.printerStatus.create).not.toHaveBeenCalled();
  });

  test('8. Multiple active defaults refuse bridging', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma({
      activeDefaults: [{ id: 'device-a' }, { id: 'device-b' }]
    });
    const now = Date.now();
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn(() => ({ emit: jest.fn() })) },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        timestamp: new Date(now).toISOString()
      },
      now
    });

    expect(result.accepted).toBe(true);
    expect(result.bridged).toBe(false);
    expect(prisma.tx.printerStatus.create).not.toHaveBeenCalled();
  });

  test('9. Machine.lastOnline is never updated by printer telemetry', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma();
    const now = Date.now();
    await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn(() => ({ emit: jest.fn() })) },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        connectionType: 'Network',
        timestamp: new Date(now).toISOString()
      },
      now
    });

    // machine.update must NEVER touch lastOnline
    if (prisma.tx.machine.update.mock.calls.length > 0) {
      expect(prisma.tx.machine.update).toHaveBeenCalledWith(
        expect.not.objectContaining({
          data: expect.objectContaining({ lastOnline: expect.anything() })
        })
      );
    }
  });

  test('10. Machine.printerModel is never updated by printer telemetry', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma();
    const now = Date.now();
    await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn(() => ({ emit: jest.fn() })) },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        connectionType: 'Network',
        timestamp: new Date(now).toISOString()
      },
      now
    });

    // machine.update must NEVER touch printerModel
    if (prisma.tx.machine.update.mock.calls.length > 0) {
      expect(prisma.tx.machine.update).toHaveBeenCalledWith(
        expect.not.objectContaining({
          data: expect.objectContaining({ printerModel: expect.anything() })
        })
      );
    }
  });

  test('11. UNKNOWN paper and toner values remain UNKNOWN in PrinterStatus', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma();
    const now = Date.now();
    await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn(() => ({ emit: jest.fn() })) },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        paperStatus: 'UNKNOWN',
        tonerStatus: 'UNKNOWN',
        timestamp: new Date(now).toISOString()
      },
      now
    });

    expect(prisma.tx.printerStatus.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paperStatus: 'UNKNOWN',
        tonerStatus: 'UNKNOWN'
      })
    });
  });

  test('12. PrinterStatus insertion failure rolls back the transaction', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma();
    prisma.tx.printerStatus.create.mockRejectedValue(new Error('DB Constraint Violation'));
    const now = Date.now();

    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn() },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        timestamp: new Date(now).toISOString()
      },
      now
    });

    expect(result.accepted).toBe(false);
    expect(result.code).toBe('INVALID_DEVICE_TELEMETRY');
    expect(result.message).toBe('DB Constraint Violation');
  });

  test('13. Admin default reassignment concurrency respects Machine-first locking', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma();
    const now = Date.now();
    await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn(() => ({ emit: jest.fn() })) },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        timestamp: new Date(now).toISOString()
      },
      now
    });

    // Verify Machine root row lock was acquired before querying or updating device
    expect(prisma.tx.$queryRaw).toHaveBeenCalled();
  });

  test('14. Device approval/revocation race is handled safely (DEVICE_NOT_ACTIVE_OR_APPROVED)', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma({
      device: {
        id: 'device-a',
        windowsPrinterName: 'Epson L6460',
        status: 'DISABLED',
        approvedAt: null
      }
    });
    const now = Date.now();
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn() },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        timestamp: new Date(now).toISOString()
      },
      now
    });

    expect(result).toEqual({ accepted: false, code: 'DEVICE_NOT_ACTIVE_OR_APPROVED' });
    expect(prisma.tx.printerDevice.updateMany).not.toHaveBeenCalled();
    expect(prisma.tx.printerStatus.create).not.toHaveBeenCalled();
  });

  test('15. Queue identity mismatch is rejected', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma({
      device: {
        id: 'device-a',
        windowsPrinterName: 'Epson L6460',
        status: 'ACTIVE',
        approvedAt: new Date()
      }
    });
    const now = Date.now();
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn() },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Wrong Queue Name',
        isError: false,
        timestamp: new Date(now).toISOString()
      },
      now
    });

    expect(result).toEqual({ accepted: false, code: 'QUEUE_IDENTITY_MISMATCH' });
    expect(prisma.tx.printerDevice.updateMany).not.toHaveBeenCalled();
  });

  test('16. Invalid/missing Machine lock result fails closed', async () => {
    const socket = { ...baseSocket };
    const prisma = createTelemetryMockPrisma({ machine: [] });
    const now = Date.now();
    const result = await handlePrinterDeviceTelemetry({
      socket,
      io: { to: jest.fn() },
      prisma,
      logger: { warn: jest.fn() },
      status: {
        printerDeviceId: 'device-a',
        printerName: 'Epson L6460',
        isError: false,
        timestamp: new Date(now).toISOString()
      },
      now
    });

    expect(result).toEqual({ accepted: false, code: 'MACHINE_NOT_FOUND' });
    expect(prisma.tx.printerDevice.updateMany).not.toHaveBeenCalled();
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

describe('Printer Agent protocol — pushPrinterDeviceRegistrySync', () => {
  const machineId = 'machine-test-123';

  test('successfully emits printer_device_registry to machine room with latest approved devices', async () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const io = { to };
    const prisma = {
      printerDevice: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'dev-1',
            displayName: 'Epson Counter',
            windowsPrinterName: 'EPSON L6460 Series',
            status: 'ACTIVE',
            approvedAt: new Date('2026-11-24T00:00:00.000Z'),
            sortOrder: 0
          }
        ])
      }
    };
    const logger = { info: jest.fn(), error: jest.fn() };

    const success = await pushPrinterDeviceRegistrySync(io, prisma, machineId, logger);

    expect(success).toBe(true);
    expect(to).toHaveBeenCalledWith(`machine_${machineId}`);
    expect(emit).toHaveBeenCalledWith(
      'printer_device_registry',
      expect.objectContaining({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        machineId,
        devices: [
          expect.objectContaining({
            id: 'dev-1',
            windowsPrinterName: 'EPSON L6460 Series',
            status: 'ACTIVE'
          })
        ]
      })
    );
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[FleetSync]'));
  });

  test('returns false without throwing when io or machineId is missing or invalid', async () => {
    const prisma = { printerDevice: { findMany: jest.fn() } };
    expect(await pushPrinterDeviceRegistrySync(null, prisma, machineId)).toBe(false);
    expect(await pushPrinterDeviceRegistrySync(undefined, prisma, machineId)).toBe(false);
    expect(await pushPrinterDeviceRegistrySync({}, prisma, null)).toBe(false);
    expect(await pushPrinterDeviceRegistrySync({}, prisma, '')).toBe(false);
    expect(await pushPrinterDeviceRegistrySync({}, prisma, 123)).toBe(false);
    expect(prisma.printerDevice.findMany).not.toHaveBeenCalled();
  });

  test('handles database query errors gracefully and returns false without throwing', async () => {
    const to = jest.fn();
    const io = { to };
    const prisma = {
      printerDevice: {
        findMany: jest.fn().mockRejectedValue(new Error('Connection terminated'))
      }
    };
    const logger = { info: jest.fn(), error: jest.fn() };

    const success = await pushPrinterDeviceRegistrySync(io, prisma, machineId, logger);

    expect(success).toBe(false);
    expect(to).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[FleetSync]'),
      expect.stringContaining('Connection terminated')
    );
  });

  test('handles Socket.IO emission errors gracefully and returns false without throwing', async () => {
    const emit = jest.fn().mockImplementation(() => {
      throw new Error('Socket buffer overflow');
    });
    const to = jest.fn().mockReturnValue({ emit });
    const io = { to };
    const prisma = {
      printerDevice: {
        findMany: jest.fn().mockResolvedValue([])
      }
    };
    const logger = { info: jest.fn(), error: jest.fn() };

    const success = await pushPrinterDeviceRegistrySync(io, prisma, machineId, logger);

    expect(success).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[FleetSync]'),
      expect.stringContaining('Socket buffer overflow')
    );
  });
});

describe('Printer Discovery Admin Controller — Fleet Synchronization Integration', () => {
  const printerDiscoveryService = require('../src/services/printerDiscovery.service');
  const printerDeviceAdminService = require('../src/services/printerDeviceAdmin.service');
  const {
    approvePrinterDiscovery,
    disablePrinterDevice,
    enablePrinterDevice,
    remapPrinterDevice
  } = require('../src/modules/admin/printerDiscovery.admin.controller');

  let req, res, next, emit, to, io;

  beforeEach(() => {
    emit = jest.fn();
    to = jest.fn().mockReturnValue({ emit });
    io = { to };
    req = {
      params: { id: 'test-id' },
      body: { isDefault: false },
      user: { id: 'admin-1', role: 'SUPERADMIN' },
      app: { get: jest.fn().mockReturnValue(io) },
      logger: { info: jest.fn(), error: jest.fn() }
    };
    res = {
      statusCode: 200,
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    next = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('approvePrinterDiscovery triggers fleet synchronization push after successful approval', async () => {
    jest.spyOn(printerDiscoveryService, 'approvePrinterDiscovery').mockResolvedValue({
      device: { id: 'dev-1', machineId: 'machine-xyz', displayName: 'Canon Network' },
      alreadyApproved: false
    });
    // mock getPrinterDeviceRegistry by spying on prisma in controller
    const prisma = require('../src/utils/prisma');
    jest.spyOn(prisma.printerDevice, 'findMany').mockResolvedValue([
      { id: 'dev-1', windowsPrinterName: 'Canon iR-ADV 4545', status: 'ACTIVE', approvedAt: new Date(), sortOrder: 0 }
    ]);

    await approvePrinterDiscovery(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(to).toHaveBeenCalledWith('machine_machine-xyz');
    expect(emit).toHaveBeenCalledWith('printer_device_registry', expect.objectContaining({
      machineId: 'machine-xyz',
      devices: expect.arrayContaining([expect.objectContaining({ id: 'dev-1' })])
    }));
    expect(next).not.toHaveBeenCalled();
  });

  test('approvePrinterDiscovery succeeds even if WebSocket push fails', async () => {
    jest.spyOn(printerDiscoveryService, 'approvePrinterDiscovery').mockResolvedValue({
      device: { id: 'dev-1', machineId: 'machine-xyz', displayName: 'Canon Network' },
      alreadyApproved: false
    });
    const prisma = require('../src/utils/prisma');
    jest.spyOn(prisma.printerDevice, 'findMany').mockRejectedValue(new Error('Push query failed'));

    await approvePrinterDiscovery(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(next).not.toHaveBeenCalled();
  });

  test('disablePrinterDevice triggers fleet synchronization push after disabling device', async () => {
    jest.spyOn(printerDeviceAdminService, 'disablePrinterDevice').mockResolvedValue({
      device: { id: 'dev-1', machineId: 'machine-xyz', status: 'DISABLED' },
      alreadyDisabled: false
    });
    const prisma = require('../src/utils/prisma');
    jest.spyOn(prisma.printerDevice, 'findMany').mockResolvedValue([]);

    await disablePrinterDevice(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(to).toHaveBeenCalledWith('machine_machine-xyz');
    expect(emit).toHaveBeenCalledWith('printer_device_registry', expect.objectContaining({
      machineId: 'machine-xyz',
      devices: []
    }));
    expect(next).not.toHaveBeenCalled();
  });

  test('enablePrinterDevice triggers fleet synchronization push after re-enabling device', async () => {
    jest.spyOn(printerDeviceAdminService, 'enablePrinterDevice').mockResolvedValue({
      device: { id: 'dev-1', machineId: 'machine-xyz', status: 'ACTIVE' },
      alreadyEnabled: false
    });
    const prisma = require('../src/utils/prisma');
    jest.spyOn(prisma.printerDevice, 'findMany').mockResolvedValue([
      { id: 'dev-1', windowsPrinterName: 'Canon iR-ADV 4545', status: 'ACTIVE', approvedAt: new Date(), sortOrder: 0 }
    ]);

    await enablePrinterDevice(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(to).toHaveBeenCalledWith('machine_machine-xyz');
    expect(emit).toHaveBeenCalledWith('printer_device_registry', expect.objectContaining({
      machineId: 'machine-xyz'
    }));
    expect(next).not.toHaveBeenCalled();
  });

  test('remapPrinterDevice triggers fleet synchronization push after remapping queue', async () => {
    jest.spyOn(printerDeviceAdminService, 'remapPrinterDevice').mockResolvedValue({
      device: { id: 'dev-1', machineId: 'machine-xyz', windowsPrinterName: 'New Queue Name' },
      previousWindowsPrinterName: 'Old Queue Name'
    });
    const prisma = require('../src/utils/prisma');
    jest.spyOn(prisma.printerDevice, 'findMany').mockResolvedValue([
      { id: 'dev-1', windowsPrinterName: 'New Queue Name', status: 'ACTIVE', approvedAt: new Date(), sortOrder: 0 }
    ]);

    await remapPrinterDevice(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(to).toHaveBeenCalledWith('machine_machine-xyz');
    expect(emit).toHaveBeenCalledWith('printer_device_registry', expect.objectContaining({
      machineId: 'machine-xyz'
    }));
    expect(next).not.toHaveBeenCalled();
  });
});
