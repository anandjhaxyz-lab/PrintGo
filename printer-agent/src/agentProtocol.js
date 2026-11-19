const fs = require('fs');
const os = require('os');

const AGENT_PROTOCOL_VERSION = 1;
const JOURNAL_SCHEMA_VERSION = 2;
const MAX_REGISTERED_PRINTERS = 10;

class AgentProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentProtocolError';
    this.code = code;
  }
}

function readInstallationId(markerPath) {
  if (!markerPath || typeof markerPath !== 'string') return null;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (
      marker &&
      typeof marker.installationId === 'string' &&
      marker.installationId.trim().length > 0 &&
      marker.installationId.length <= 128
    ) {
      return marker.installationId.trim();
    }
  } catch {
    // Identity metadata is optional for protocol negotiation. Do not mutate or
    // recreate the installation marker here.
  }
  return null;
}

function buildAgentHello(options = {}) {
  const platform = options.platform || os.platform();
  const arch = options.arch || (platform === 'win32' && os.platform() !== 'win32' ? 'x64' : os.arch());
  const release = options.release !== undefined
    ? options.release
    : (platform === 'win32' && os.platform() !== 'win32' ? '10.0.22631' : os.release());
  const majorVersion = parseInt(String(release || '').split('.')[0], 10);
  const isWindows10Or11 = Number.isFinite(majorVersion) && majorVersion >= 10;
  const supportsMultiPrinter = platform === 'win32' && arch === 'x64' && isWindows10Or11;
  const installationId = options.installationId || readInstallationId(options.markerPath);

  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentVersion: typeof options.agentVersion === 'string' ? options.agentVersion.slice(0, 32) : 'unknown',
    installationId,
    journalSchemaVersion: Number.isInteger(options.journalSchemaVersion)
      ? options.journalSchemaVersion
      : JOURNAL_SCHEMA_VERSION,
    host: {
      platform,
      arch,
      release: typeof release === 'string' ? release.slice(0, 64) : ''
    },
    capabilities: {
      multiPrinter: supportsMultiPrinter,
      printerDiscovery: supportsMultiPrinter,
      maxPrinters: supportsMultiPrinter ? MAX_REGISTERED_PRINTERS : 1
    }
  };
}

function validatePrinterDeviceRegistry(payload, expectedMachineId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AgentProtocolError('INVALID_REGISTRY_PAYLOAD', 'PrinterDevice registry payload must be an object.');
  }
  if (payload.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    throw new AgentProtocolError('UNSUPPORTED_REGISTRY_PROTOCOL', 'PrinterDevice registry protocol version is unsupported.');
  }
  if (
    typeof expectedMachineId !== 'string' ||
    !expectedMachineId ||
    payload.machineId !== expectedMachineId
  ) {
    throw new AgentProtocolError('MACHINE_ID_MISMATCH', 'PrinterDevice registry belongs to a different Machine.');
  }
  if (!Array.isArray(payload.devices) || payload.devices.length > MAX_REGISTERED_PRINTERS) {
    throw new AgentProtocolError('INVALID_REGISTRY_COUNT', 'PrinterDevice registry must contain at most 10 devices.');
  }

  const seenIds = new Set();
  const seenQueues = new Set();
  return payload.devices.map((device) => {
    if (!device || typeof device !== 'object' || Array.isArray(device)) {
      throw new AgentProtocolError('INVALID_DEVICE_RECORD', 'PrinterDevice registry contains a malformed record.');
    }

    const id = typeof device.id === 'string' ? device.id.trim() : '';
    const windowsPrinterName = typeof device.windowsPrinterName === 'string'
      ? device.windowsPrinterName.trim()
      : '';

    if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new AgentProtocolError('INVALID_DEVICE_ID', 'PrinterDevice registry contains an invalid ID.');
    }
    if (!windowsPrinterName || windowsPrinterName.length > 256 || /[\u0000-\u001f\u007f]/.test(windowsPrinterName)) {
      throw new AgentProtocolError('INVALID_QUEUE_NAME', 'PrinterDevice registry contains an invalid Windows queue name.');
    }
    if (typeof device.status !== 'string' || !['DISCOVERY_REQUIRED', 'PENDING_APPROVAL', 'ACTIVE', 'DISABLED', 'MAINTENANCE'].includes(device.status)) {
      throw new AgentProtocolError('INVALID_DEVICE_STATUS', 'PrinterDevice registry contains an invalid lifecycle status.');
    }

    const queueKey = windowsPrinterName.toLowerCase();
    if (seenIds.has(id) || seenQueues.has(queueKey)) {
      throw new AgentProtocolError('DUPLICATE_DEVICE_BINDING', 'PrinterDevice registry contains duplicate device or queue bindings.');
    }
    seenIds.add(id);
    seenQueues.add(queueKey);

    return {
      id,
      displayName: typeof device.displayName === 'string' ? device.displayName.slice(0, 256) : windowsPrinterName,
      windowsPrinterName,
      status: device.status,
      approvedAt: typeof device.approvedAt === 'string' && device.approvedAt.trim() ? device.approvedAt : null,
      sortOrder: Number.isFinite(device.sortOrder) ? device.sortOrder : 0
    };
  });
}

module.exports = {
  AGENT_PROTOCOL_VERSION,
  JOURNAL_SCHEMA_VERSION,
  MAX_REGISTERED_PRINTERS,
  AgentProtocolError,
  readInstallationId,
  buildAgentHello,
  validatePrinterDeviceRegistry
};
