const prisma = require('../utils/prisma');
const { DEFAULT_PAYMENT_MODE } = require('../constants/paymentModes');

const ONLINE_HEARTBEAT_WINDOW_MS = 90 * 1000; // 90 seconds
const TELEMETRY_STALE_WINDOW_MS = 180 * 1000; // 180 seconds (3 minutes)

const PRINTER_STATES = Object.freeze({
  ONLINE: 'ONLINE',
  AGENT_OFFLINE: 'AGENT_OFFLINE',
  PRINTER_DISCONNECTED: 'PRINTER_DISCONNECTED',
  PAPER_OUT: 'PAPER_OUT',
  JAMMED: 'JAMMED',
  UNKNOWN: 'UNKNOWN',
});

const CUSTOMER_STATUS_MESSAGES = Object.freeze({
  [PRINTER_STATES.ONLINE]: 'Printer Ready',
  [PRINTER_STATES.AGENT_OFFLINE]: 'Printer Temporarily Offline',
  [PRINTER_STATES.PRINTER_DISCONNECTED]: 'Printer Disconnected',
  [PRINTER_STATES.PAPER_OUT]: 'Out of Paper',
  [PRINTER_STATES.JAMMED]: 'Paper Jam',
  [PRINTER_STATES.UNKNOWN]: 'Printer Status Unavailable',
});

/**
 * Evaluates readiness and telemetry freshness for an individual child printer device.
 *
 * @param {Object} device - PrinterDevice record
 * @param {number} refTimeMs - Reference epoch timestamp
 * @returns {Object}
 */
const evaluateChildDevice = (device, refTimeMs) => {
  if (!device || typeof device !== 'object') {
    return {
      id: null,
      status: PRINTER_STATES.UNKNOWN,
      isReady: false,
      isStale: true,
      lastTelemetryAt: null,
    };
  }

  const telemetryDate = device.lastTelemetryAt || device.updatedAt;
  const telemetryMs = telemetryDate ? new Date(telemetryDate).getTime() : NaN;
  const isStale =
    Number.isNaN(telemetryMs) ||
    refTimeMs - telemetryMs < 0 ||
    refTimeMs - telemetryMs > TELEMETRY_STALE_WINDOW_MS;

  if (isStale) {
    return {
      id: device.id,
      displayName: device.displayName || 'Unknown Printer',
      windowsPrinterName: device.windowsPrinterName || null,
      status: PRINTER_STATES.UNKNOWN,
      isReady: false,
      isStale: true,
      lastTelemetryAt: device.lastTelemetryAt ? new Date(device.lastTelemetryAt).toISOString() : null,
    };
  }

  const rawHealth = (device.healthStatus || 'UNKNOWN').toUpperCase();
  let status = PRINTER_STATES.UNKNOWN;
  let isReady = false;

  if (rawHealth === 'ONLINE') {
    status = PRINTER_STATES.ONLINE;
    isReady = true;
  } else if (rawHealth === 'PAPER_OUT') {
    status = PRINTER_STATES.PAPER_OUT;
    isReady = false;
  } else if (rawHealth === 'JAMMED') {
    status = PRINTER_STATES.JAMMED;
    isReady = false;
  } else if (rawHealth === 'OFFLINE') {
    status = PRINTER_STATES.PRINTER_DISCONNECTED;
    isReady = false;
  } else {
    status = 'ERROR';
    isReady = false;
  }

  return {
    id: device.id,
    displayName: device.displayName || 'Unknown Printer',
    windowsPrinterName: device.windowsPrinterName || null,
    status,
    isReady,
    isStale: false,
    lastTelemetryAt: device.lastTelemetryAt ? new Date(device.lastTelemetryAt).toISOString() : null,
  };
};

/**
 * Aggregates individual child device readiness into parent machine availability.
 *
 * @param {Array<Object>} evaluatedDevices
 * @returns {Object}
 */
const aggregateChildDevices = (evaluatedDevices) => {
  if (!Array.isArray(evaluatedDevices) || evaluatedDevices.length === 0) {
    return null;
  }

  const readyDevices = evaluatedDevices.filter((d) => d.isReady);
  const staleDevices = evaluatedDevices.filter((d) => d.isStale);

  // 1. If at least one active child device is ready, parent machine is operational
  if (readyDevices.length > 0) {
    return {
      status: PRINTER_STATES.ONLINE,
      isReady: true,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.ONLINE],
      paperStatus: 'OK',
      tonerStatus: 'OK',
      jamStatus: false,
      activeDeviceCount: evaluatedDevices.length,
      readyDeviceCount: readyDevices.length,
      deviceReadiness: evaluatedDevices,
    };
  }

  // 2. If all child devices have stale or missing telemetry, fail closed to UNKNOWN
  if (staleDevices.length === evaluatedDevices.length) {
    return {
      status: PRINTER_STATES.UNKNOWN,
      isReady: false,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.UNKNOWN],
      paperStatus: 'UNKNOWN',
      tonerStatus: 'UNKNOWN',
      jamStatus: false,
      activeDeviceCount: evaluatedDevices.length,
      readyDeviceCount: 0,
      deviceReadiness: evaluatedDevices,
    };
  }

  // 3. Evaluate non-stale reporting devices
  const reportingDevices = evaluatedDevices.filter((d) => !d.isStale);
  if (reportingDevices.length > 0 && reportingDevices.every((d) => d.status === PRINTER_STATES.PAPER_OUT)) {
    return {
      status: PRINTER_STATES.PAPER_OUT,
      isReady: false,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.PAPER_OUT],
      paperStatus: 'OUT',
      tonerStatus: 'OK',
      jamStatus: false,
      activeDeviceCount: evaluatedDevices.length,
      readyDeviceCount: 0,
      deviceReadiness: evaluatedDevices,
    };
  }

  if (reportingDevices.length > 0 && reportingDevices.every((d) => d.status === PRINTER_STATES.JAMMED)) {
    return {
      status: PRINTER_STATES.JAMMED,
      isReady: false,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.JAMMED],
      paperStatus: 'OK',
      tonerStatus: 'OK',
      jamStatus: true,
      activeDeviceCount: evaluatedDevices.length,
      readyDeviceCount: 0,
      deviceReadiness: evaluatedDevices,
    };
  }

  if (reportingDevices.length > 0 && reportingDevices.every((d) => d.status === PRINTER_STATES.PRINTER_DISCONNECTED)) {
    return {
      status: PRINTER_STATES.PRINTER_DISCONNECTED,
      isReady: false,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.PRINTER_DISCONNECTED],
      paperStatus: 'UNKNOWN',
      tonerStatus: 'UNKNOWN',
      jamStatus: false,
      activeDeviceCount: evaluatedDevices.length,
      readyDeviceCount: 0,
      deviceReadiness: evaluatedDevices,
    };
  }

  // 4. Any remaining error condition or mixed non-ready failures
  return {
    status: 'ERROR',
    isReady: false,
    statusMessage: 'Printer Error',
    paperStatus: 'UNKNOWN',
    tonerStatus: 'UNKNOWN',
    jamStatus: false,
    activeDeviceCount: evaluatedDevices.length,
    readyDeviceCount: 0,
    deviceReadiness: evaluatedDevices,
  };
};

/**
 * Computes authoritative printer availability from Machine record and latest PrinterStatus telemetry
 * or active child PrinterDevice records.
 *
 * Rules:
 * 1. AGENT_OFFLINE: If machine is missing, not ACTIVE, lastOnline is missing, or lastOnline > 90s old.
 * 2. If Agent is ONLINE:
 *    A. Multi-Printer Fleet Mode (when active child devices exist on the machine or passed via childDevices):
 *       - Evaluates freshness and readiness for each active child device.
 *       - Aggregates parent machine status (ONLINE if at least 1 device ready; UNKNOWN if all stale).
 *       - Preserves individual device readiness in deviceReadiness.
 *    B. Legacy Single-Printer Mode (when no active child devices exist):
 *       - UNKNOWN: If latestPrinterStatus is missing, invalid, or timestamp > 180s old.
 *       - PAPER_OUT: If latestPrinterStatus reports paperStatus === 'OUT'.
 *       - JAMMED: If latestPrinterStatus reports jamStatus === true.
 *       - PRINTER_DISCONNECTED: If latestPrinterStatus reports isOnline === false.
 *       - ONLINE: If latestPrinterStatus reports isOnline === true, paperStatus !== 'OUT', jamStatus !== true.
 *
 * Missing or stale telemetry strictly fails closed (never ONLINE).
 *
 * @param {Object} machine - Machine object with status, lastOnline, and optional printerDevices
 * @param {Object} [latestPrinterStatus] - Latest PrinterStatus row (legacy fallback)
 * @param {Date|number|string} [now=new Date()] - Reference timestamp
 * @param {Array<Object>} [childDevices=null] - Optional child devices override
 * @returns {Object} { status, isReady, agentOnline, statusMessage, paperStatus, tonerStatus, jamStatus }
 */
const computePrinterAvailability = (
  machine,
  latestPrinterStatus = null,
  now = new Date(),
  childDevices = null
) => {
  const refTimeMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (Number.isNaN(refTimeMs)) {
    return {
      status: PRINTER_STATES.UNKNOWN,
      isReady: false,
      agentOnline: false,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.UNKNOWN],
      paperStatus: 'UNKNOWN',
      tonerStatus: 'UNKNOWN',
      jamStatus: false,
    };
  }

  // 1. Evaluate Agent Heartbeat (strict priority)
  if (!machine || typeof machine !== 'object') {
    return {
      status: PRINTER_STATES.AGENT_OFFLINE,
      isReady: false,
      agentOnline: false,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.AGENT_OFFLINE],
      paperStatus: 'UNKNOWN',
      tonerStatus: 'UNKNOWN',
      jamStatus: false,
    };
  }

  if (machine.status !== 'ACTIVE' || !machine.lastOnline) {
    return {
      status: PRINTER_STATES.AGENT_OFFLINE,
      isReady: false,
      agentOnline: false,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.AGENT_OFFLINE],
      paperStatus: 'UNKNOWN',
      tonerStatus: 'UNKNOWN',
      jamStatus: false,
    };
  }

  const lastOnlineMs = new Date(machine.lastOnline).getTime();
  if (Number.isNaN(lastOnlineMs)) {
    return {
      status: PRINTER_STATES.AGENT_OFFLINE,
      isReady: false,
      agentOnline: false,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.AGENT_OFFLINE],
      paperStatus: 'UNKNOWN',
      tonerStatus: 'UNKNOWN',
      jamStatus: false,
    };
  }

  const agentDiffMs = refTimeMs - lastOnlineMs;
  // Future timestamps or timestamps older than 90s fail closed
  if (agentDiffMs < 0 || agentDiffMs > ONLINE_HEARTBEAT_WINDOW_MS) {
    return {
      status: PRINTER_STATES.AGENT_OFFLINE,
      isReady: false,
      agentOnline: false,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.AGENT_OFFLINE],
      paperStatus: 'UNKNOWN',
      tonerStatus: 'UNKNOWN',
      jamStatus: false,
    };
  }

  const agentOnline = true;

  // 2. Evaluate Child Devices (Multi-Printer Mode) if present
  const rawDevices = Array.isArray(childDevices)
    ? childDevices
    : Array.isArray(machine.printerDevices)
      ? machine.printerDevices
      : [];

  const activeChildDevices = rawDevices.filter(
    (d) => d && typeof d === 'object' && (d.status === 'ACTIVE' || (!d.status && d.healthStatus))
  );

  if (activeChildDevices.length > 0) {
    const evaluatedDevices = activeChildDevices.map((d) => evaluateChildDevice(d, refTimeMs));
    const aggregated = aggregateChildDevices(evaluatedDevices);
    if (aggregated) {
      return {
        ...aggregated,
        agentOnline,
      };
    }
  }

  // 3. Fallback: Evaluate Legacy Physical Printer Telemetry (Single-Printer Mode)
  if (!latestPrinterStatus || typeof latestPrinterStatus !== 'object') {
    return {
      status: PRINTER_STATES.UNKNOWN,
      isReady: false,
      agentOnline,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.UNKNOWN],
      paperStatus: 'UNKNOWN',
      tonerStatus: 'UNKNOWN',
      jamStatus: false,
    };
  }

  const telemetryDate = latestPrinterStatus.timestamp || latestPrinterStatus.createdAt;
  if (!telemetryDate) {
    return {
      status: PRINTER_STATES.UNKNOWN,
      isReady: false,
      agentOnline,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.UNKNOWN],
      paperStatus: latestPrinterStatus.paperStatus || 'UNKNOWN',
      tonerStatus: latestPrinterStatus.tonerStatus || 'UNKNOWN',
      jamStatus: Boolean(latestPrinterStatus.jamStatus),
    };
  }

  const telemetryMs = new Date(telemetryDate).getTime();
  if (Number.isNaN(telemetryMs)) {
    return {
      status: PRINTER_STATES.UNKNOWN,
      isReady: false,
      agentOnline,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.UNKNOWN],
      paperStatus: latestPrinterStatus.paperStatus || 'UNKNOWN',
      tonerStatus: latestPrinterStatus.tonerStatus || 'UNKNOWN',
      jamStatus: Boolean(latestPrinterStatus.jamStatus),
    };
  }

  const telemetryDiffMs = refTimeMs - telemetryMs;
  if (telemetryDiffMs < 0 || telemetryDiffMs > TELEMETRY_STALE_WINDOW_MS) {
    return {
      status: PRINTER_STATES.UNKNOWN,
      isReady: false,
      agentOnline,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.UNKNOWN],
      paperStatus: latestPrinterStatus.paperStatus || 'UNKNOWN',
      tonerStatus: latestPrinterStatus.tonerStatus || 'UNKNOWN',
      jamStatus: Boolean(latestPrinterStatus.jamStatus),
    };
  }

  const paperStatus = latestPrinterStatus.paperStatus || 'OK';
  const tonerStatus = latestPrinterStatus.tonerStatus || 'OK';
  const jamStatus = Boolean(latestPrinterStatus.jamStatus);
  const isOnline = Boolean(latestPrinterStatus.isOnline);

  if (paperStatus === 'OUT') {
    return {
      status: PRINTER_STATES.PAPER_OUT,
      isReady: false,
      agentOnline,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.PAPER_OUT],
      paperStatus,
      tonerStatus,
      jamStatus,
    };
  }

  if (jamStatus) {
    return {
      status: PRINTER_STATES.JAMMED,
      isReady: false,
      agentOnline,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.JAMMED],
      paperStatus,
      tonerStatus,
      jamStatus,
    };
  }

  if (!isOnline) {
    return {
      status: PRINTER_STATES.PRINTER_DISCONNECTED,
      isReady: false,
      agentOnline,
      statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.PRINTER_DISCONNECTED],
      paperStatus,
      tonerStatus,
      jamStatus,
    };
  }

  return {
    status: PRINTER_STATES.ONLINE,
    isReady: true,
    agentOnline,
    statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.ONLINE],
    paperStatus,
    tonerStatus,
    jamStatus,
  };
};

/**
 * Loads machine and latest printer telemetry from DB and computes availability.
 *
 * @param {string} machineId
 * @param {Object} [dbClient=prisma]
 * @param {Date} [now=new Date()]
 */
const getMachineAvailability = async (machineId, dbClient = prisma, now = new Date()) => {
  if (!machineId) return null;

  const machine = await dbClient.machine.findUnique({
    where: { id: machineId },
    include: {
      printerStatuses: {
        take: 1,
        orderBy: { timestamp: 'desc' },
      },
      printerDevices: {
        where: { status: 'ACTIVE' },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });

  if (!machine) return null;

  const latestStatus = machine.printerStatuses?.[0] || null;
  const availability = computePrinterAvailability(machine, latestStatus, now);

  return {
    machineId: machine.id,
    name: machine.name,
    location: machine.location,
    printerModel: machine.printerModel || 'Unknown',
    connectionType: machine.connectionType || latestStatus?.connectionType || 'Unknown',
    paymentMode: machine.paymentMode || DEFAULT_PAYMENT_MODE,
    ...availability,
  };
};

module.exports = {
  ONLINE_HEARTBEAT_WINDOW_MS,
  TELEMETRY_STALE_WINDOW_MS,
  PRINTER_STATES,
  CUSTOMER_STATUS_MESSAGES,
  computePrinterAvailability,
  getMachineAvailability,
};
