const { recordPrinterDiscoveryInventory } = require('./printerDiscovery.service');

const AGENT_PROTOCOL_VERSION = 1;
const MAX_REGISTERED_PRINTERS = 10;
const MAX_DISCOVERED_QUEUES = 50;
const MAX_QUEUE_NAME_LENGTH = 256;

class PrinterAgentProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrinterAgentProtocolError';
    this.code = code;
  }
}

const isPlainObject = (value) => (
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value)
);

const boundedText = (value, maxLength, fieldName, required = false) => {
  if (value === null || value === undefined) {
    if (required) throw new PrinterAgentProtocolError('INVALID_' + fieldName.toUpperCase(), `${fieldName} is required.`);
    return null;
  }
  if (typeof value !== 'string') {
    throw new PrinterAgentProtocolError('INVALID_' + fieldName.toUpperCase(), `${fieldName} must be a string.`);
  }
  const normalized = value.trim();
  if ((!normalized && required) || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new PrinterAgentProtocolError('INVALID_' + fieldName.toUpperCase(), `${fieldName} is empty or invalid.`);
  }
  return normalized || null;
};

const nullableBoolean = (value, fieldName) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') {
    throw new PrinterAgentProtocolError('INVALID_' + fieldName.toUpperCase(), `${fieldName} must be boolean or null.`);
  }
  return value;
};

const nullableStatusValue = (value, fieldName) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  throw new PrinterAgentProtocolError('INVALID_' + fieldName.toUpperCase(), `${fieldName} must be a short string, finite number or null.`);
};

function validateAgentHello(payload) {
  if (!isPlainObject(payload)) {
    return { accepted: false, code: 'INVALID_HELLO', reason: 'Agent hello payload must be an object.' };
  }

  if (payload.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    return {
      accepted: false,
      code: 'UNSUPPORTED_PROTOCOL_VERSION',
      reason: `Agent protocol version ${payload.protocolVersion} is not supported.`
    };
  }

  if (!Number.isInteger(payload.journalSchemaVersion) || payload.journalSchemaVersion < 1 || payload.journalSchemaVersion > 2) {
    return {
      accepted: false,
      code: 'UNSUPPORTED_JOURNAL_SCHEMA',
      reason: 'Agent journal schema version is not supported by this backend.'
    };
  }

  let agentVersion;
  let installationId;
  let host;
  try {
    agentVersion = boundedText(payload.agentVersion, 32, 'agentVersion') || 'unknown';
    installationId = boundedText(payload.installationId, 128, 'installationId');
    if (!isPlainObject(payload.host)) {
      throw new PrinterAgentProtocolError('INVALID_HOST', 'Agent host information is required.');
    }
    host = {
      platform: boundedText(payload.host.platform, 24, 'host.platform', true),
      arch: boundedText(payload.host.arch, 24, 'host.arch', true),
      release: boundedText(payload.host.release, 64, 'host.release')
    };
  } catch (error) {
    return {
      accepted: false,
      code: error.code || 'INVALID_HELLO',
      reason: error.message
    };
  }

  const capabilities = isPlainObject(payload.capabilities) ? payload.capabilities : {};
  const maxPrinters = Number.isInteger(capabilities.maxPrinters) ? capabilities.maxPrinters : 0;
  const supportsMultiPrinter =
    host.platform === 'win32' &&
    host.arch === 'x64' &&
    capabilities.multiPrinter === true &&
    capabilities.printerDiscovery === true &&
    maxPrinters >= 1 &&
    maxPrinters <= MAX_REGISTERED_PRINTERS &&
    payload.journalSchemaVersion >= 2;

  return {
    accepted: true,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentVersion,
    installationId,
    journalSchemaVersion: payload.journalSchemaVersion,
    host,
    supportsMultiPrinter,
    maxPrinters: supportsMultiPrinter ? maxPrinters : 1
  };
}

async function getPrinterDeviceRegistry(prisma, machineId) {
  if (!machineId || typeof machineId !== 'string') {
    throw new PrinterAgentProtocolError('MACHINE_ID_REQUIRED', 'Authenticated Machine identity is required.');
  }
  if (!prisma?.printerDevice || typeof prisma.printerDevice.findMany !== 'function') {
    throw new PrinterAgentProtocolError('REGISTRY_UNAVAILABLE', 'PrinterDevice registry is unavailable.');
  }

  // Only return devices bound to this authenticated Machine. Unbound legacy
  // placeholder devices stay on the old PRINTER_NAME path until explicitly mapped.
  const rows = await prisma.printerDevice.findMany({
    where: {
      machineId,
      windowsPrinterName: { not: null }
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      displayName: true,
      windowsPrinterName: true,
      status: true,
      approvedAt: true,
      sortOrder: true
    }
  });

  const devices = (Array.isArray(rows) ? rows : []).filter((row) => (
    row &&
    typeof row.windowsPrinterName === 'string' &&
    row.windowsPrinterName.trim().length > 0
  ));

  if (devices.length > MAX_REGISTERED_PRINTERS) {
    throw new PrinterAgentProtocolError(
      'FLEET_LIMIT_EXCEEDED',
      `Machine ${machineId} has more than ${MAX_REGISTERED_PRINTERS} queue-bound PrinterDevice records.`
    );
  }

  return devices.map((device) => ({
    id: device.id,
    displayName: device.displayName,
    windowsPrinterName: device.windowsPrinterName,
    status: device.status,
    approvedAt: device.approvedAt ? new Date(device.approvedAt).toISOString() : null,
    sortOrder: device.sortOrder
  }));
}

function validateDiscoveredPrinterInventory(payload) {
  if (!isPlainObject(payload) || payload.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    throw new PrinterAgentProtocolError('INVALID_INVENTORY_REPORT', 'Inventory report protocol version is invalid.');
  }

  const reported = payload.discoveredPrinters;
  if (!Array.isArray(reported) || reported.length > MAX_DISCOVERED_QUEUES) {
    throw new PrinterAgentProtocolError(
      'INVALID_INVENTORY_COUNT',
      `Inventory report must contain an array of at most ${MAX_DISCOVERED_QUEUES} discovered queues.`
    );
  }

  const seen = new Set();
  return reported.map((row) => {
    if (!isPlainObject(row)) {
      throw new PrinterAgentProtocolError('INVALID_INVENTORY_RECORD', 'Discovered queue record must be an object.');
    }

    const windowsPrinterName = boundedText(row.windowsPrinterName, MAX_QUEUE_NAME_LENGTH, 'windowsPrinterName', true);
    const key = windowsPrinterName.toLowerCase();
    if (seen.has(key)) {
      throw new PrinterAgentProtocolError('DUPLICATE_DISCOVERED_QUEUE', 'Inventory report contains duplicate Windows queue names.');
    }
    seen.add(key);

    const connectionType = row.connectionType === undefined ? 'Unknown' : row.connectionType;
    if (!['USB', 'Network', 'Unknown'].includes(connectionType)) {
      throw new PrinterAgentProtocolError('INVALID_CONNECTION_TYPE', 'Discovered queue connection type is invalid.');
    }

    return {
      windowsPrinterName,
      driverName: boundedText(row.driverName, MAX_QUEUE_NAME_LENGTH, 'driverName'),
      portName: boundedText(row.portName, MAX_QUEUE_NAME_LENGTH, 'portName'),
      connectionType,
      printerStatus: nullableStatusValue(row.printerStatus, 'printerStatus'),
      detectedErrorState: nullableStatusValue(row.detectedErrorState, 'detectedErrorState'),
      workOffline: nullableBoolean(row.workOffline, 'workOffline'),
      shared: nullableBoolean(row.shared, 'shared'),
      network: nullableBoolean(row.network, 'network'),
      isDefault: nullableBoolean(row.isDefault, 'isDefault')
    };
  });
}

async function handlePrinterAgentHello({ socket, prisma, logger, payload }) {
  if (socket?.userType !== 'printer' || !socket.machineId) {
    return { accepted: false, code: 'UNAUTHORIZED_AGENT' };
  }

  // A repeated malformed hello must revoke any previously negotiated fleet capability.
  socket.agentProtocol = null;
  const hello = validateAgentHello(payload);
  if (!hello.accepted) {
    socket.emit('printer_agent_hello_ack', hello);
    return hello;
  }

  socket.agentProtocol = {
    protocolVersion: hello.protocolVersion,
    agentVersion: hello.agentVersion,
    installationId: hello.installationId,
    journalSchemaVersion: hello.journalSchemaVersion,
    supportsMultiPrinter: hello.supportsMultiPrinter,
    connectedAt: new Date()
  };

  socket.emit('printer_agent_hello_ack', {
    accepted: true,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    machineId: socket.machineId,
    supportsMultiPrinter: hello.supportsMultiPrinter,
    maxPrinters: hello.maxPrinters,
    journalSchemaVersion: hello.journalSchemaVersion
  });

  if (!hello.supportsMultiPrinter) {
    return { accepted: true, supportsMultiPrinter: false };
  }

  try {
    const devices = await getPrinterDeviceRegistry(prisma, socket.machineId);
    socket.emit('printer_device_registry', {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      machineId: socket.machineId,
      issuedAt: new Date().toISOString(),
      devices
    });
    return { accepted: true, supportsMultiPrinter: true, deviceCount: devices.length };
  } catch (error) {
    logger?.error?.(`Failed to load PrinterDevice registry for Machine ${socket.machineId}:`, error);
    socket.emit('printer_device_registry_error', {
      code: error.code || 'REGISTRY_UNAVAILABLE',
      retryable: true,
      message: 'Printer registry could not be loaded. Existing legacy printer operation is unchanged.'
    });
    return { accepted: true, supportsMultiPrinter: true, registryLoaded: false };
  }
}

async function handlePrinterInventoryReport({ socket, io, logger, prisma, payload }) {
  if (socket?.userType !== 'printer' || !socket.machineId) {
    return { accepted: false, code: 'UNAUTHORIZED_AGENT' };
  }
  if (socket.agentProtocol?.supportsMultiPrinter !== true) {
    socket.emit('printer_inventory_report_ack', {
      accepted: false,
      code: 'AGENT_PROTOCOL_NOT_NEGOTIATED',
      message: 'Multi-printer capability must be negotiated before inventory can be reported.'
    });
    return { accepted: false, code: 'AGENT_PROTOCOL_NOT_NEGOTIATED' };
  }

  try {
    const discoveredPrinters = validateDiscoveredPrinterInventory(payload);
    await recordPrinterDiscoveryInventory(prisma, socket.machineId, discoveredPrinters);
    const report = {
      machineId: socket.machineId,
      machineName: socket.machineName || null,
      reportedAt: new Date().toISOString(),
      discoveredPrinters
    };

    // Persist for Admin review only. Agent inventory never creates, approves,
    // binds, activates or modifies PrinterDevice records.
    io.to('admins').emit('printer_inventory_report', report);
    socket.emit('printer_inventory_report_ack', {
      accepted: true,
      machineId: socket.machineId,
      receivedCount: discoveredPrinters.length
    });
    return { accepted: true, receivedCount: discoveredPrinters.length };
  } catch (error) {
    logger?.warn?.(`Rejected printer inventory report from Machine ${socket.machineId}:`, error.message);
    socket.emit('printer_inventory_report_ack', {
      accepted: false,
      code: error.code || 'INVALID_INVENTORY_REPORT',
      message: error.message
    });
    return { accepted: false, code: error.code || 'INVALID_INVENTORY_REPORT' };
  }
}

async function handlePrinterDeviceTelemetry({ socket, io, prisma, logger, status }) {
  if (socket?.userType !== 'printer' || !socket.machineId) {
    return { accepted: false, code: 'UNAUTHORIZED_AGENT' };
  }
  if (socket.agentProtocol?.supportsMultiPrinter !== true) {
    return { accepted: false, code: 'AGENT_PROTOCOL_NOT_NEGOTIATED' };
  }

  try {
    if (!isPlainObject(status) || typeof status.isError !== 'boolean') {
      throw new PrinterAgentProtocolError('INVALID_DEVICE_TELEMETRY', 'Device telemetry status must contain a boolean isError field.');
    }

    const printerDeviceId = boundedText(status.printerDeviceId, 128, 'printerDeviceId', true);
    const device = await prisma.printerDevice.findFirst({
      where: {
        id: printerDeviceId,
        machineId: socket.machineId
      },
      select: { id: true }
    });

    if (!device) {
      logger?.warn?.(`Rejected printer telemetry: device ${printerDeviceId} does not belong to Machine ${socket.machineId}`);
      return { accepted: false, code: 'DEVICE_MACHINE_MISMATCH' };
    }

    const errorMessage = boundedText(status.errorMessage, 128, 'errorMessage') || '';
    const message = errorMessage.toLowerCase();
    let healthStatus = 'UNKNOWN';

    if (status.isError === false) {
      healthStatus = 'ONLINE';
    } else if (message.includes('out of paper') || message.includes('paper out')) {
      healthStatus = 'PAPER_OUT';
    } else if (message.includes('paper jam') || message.includes('jam')) {
      healthStatus = 'JAMMED';
    } else if (message.includes('offline') || message.includes('unplugged')) {
      healthStatus = 'OFFLINE';
    } else {
      healthStatus = 'ERROR';
    }

    const connectionType = ['USB', 'Network', 'Unknown'].includes(status.connectionType)
      ? status.connectionType
      : 'Unknown';
    const printerName = boundedText(status.printerName, MAX_QUEUE_NAME_LENGTH, 'printerName');
    const lastTelemetryAt = new Date();

    await prisma.printerDevice.update({
      where: { id: device.id },
      data: { healthStatus, lastTelemetryAt }
    });

    const sourceTelemetry = isPlainObject(status.telemetry) ? status.telemetry : {};
    const telemetry = {
      connectionType,
      portName: boundedText(sourceTelemetry.portName, MAX_QUEUE_NAME_LENGTH, 'telemetry.portName')
    };

    io.to('admins').emit('printer_device_status_update', {
      machineId: socket.machineId,
      printerDeviceId: device.id,
      printerName,
      connectionType,
      isError: status.isError,
      errorMessage,
      telemetry,
      healthStatus,
      lastTelemetryAt: lastTelemetryAt.toISOString()
    });

    return { accepted: true, printerDeviceId: device.id, healthStatus };
  } catch (error) {
    logger?.warn?.(`Rejected device telemetry from Machine ${socket.machineId}:`, error.message);
    return { accepted: false, code: error.code || 'INVALID_DEVICE_TELEMETRY' };
  }
}

module.exports = {
  AGENT_PROTOCOL_VERSION,
  MAX_REGISTERED_PRINTERS,
  MAX_DISCOVERED_QUEUES,
  PrinterAgentProtocolError,
  validateAgentHello,
  getPrinterDeviceRegistry,
  validateDiscoveredPrinterInventory,
  handlePrinterAgentHello,
  handlePrinterInventoryReport,
  handlePrinterDeviceTelemetry
};
