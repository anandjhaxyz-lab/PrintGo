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
 * Computes authoritative printer availability from Machine record and latest PrinterStatus telemetry.
 *
 * Rules:
 * 1. AGENT_OFFLINE: If machine is missing, not ACTIVE, lastOnline is missing, or lastOnline > 90s old.
 * 2. If Agent is ONLINE:
 *    - UNKNOWN: If latestPrinterStatus is missing, invalid, or timestamp > 180s old.
 *    - PAPER_OUT: If latestPrinterStatus reports paperStatus === 'OUT'.
 *    - JAMMED: If latestPrinterStatus reports jamStatus === true.
 *    - PRINTER_DISCONNECTED: If latestPrinterStatus reports isOnline === false.
 *    - ONLINE: If latestPrinterStatus reports isOnline === true, paperStatus !== 'OUT', jamStatus !== true.
 *
 * Missing or stale telemetry strictly fails closed (never ONLINE).
 *
 * @param {Object} machine - Machine object with status and lastOnline
 * @param {Object} [latestPrinterStatus] - Latest PrinterStatus row
 * @param {Date|number|string} [now=new Date()] - Reference timestamp
 * @returns {Object} { status, isReady, agentOnline, statusMessage, paperStatus, tonerStatus, jamStatus }
 */
const computePrinterAvailability = (machine, latestPrinterStatus = null, now = new Date()) => {
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

  // 1. Evaluate Agent Heartbeat
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

  // 2. Evaluate Physical Printer Telemetry
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
const computePrinterDeviceAvailability = (machine, device, now = new Date()) => {
  const refTimeMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!machine || machine.status !== 'ACTIVE' || !machine.lastOnline) return { status: PRINTER_STATES.AGENT_OFFLINE, isReady: false, agentOnline: false, statusMessage: 'Printer Agent Offline', paperStatus: 'UNKNOWN', tonerStatus: 'UNKNOWN', jamStatus: false };
  const heartbeatMs = new Date(machine.lastOnline).getTime();
  const heartbeatAge = refTimeMs - heartbeatMs;
  if (!Number.isFinite(heartbeatMs) || !Number.isFinite(refTimeMs) || heartbeatAge < 0 || heartbeatAge > ONLINE_HEARTBEAT_WINDOW_MS) return { status: PRINTER_STATES.AGENT_OFFLINE, isReady: false, agentOnline: false, statusMessage: 'Printer Agent Offline', paperStatus: 'UNKNOWN', tonerStatus: 'UNKNOWN', jamStatus: false };
  const telemetryMs = device && device.lastTelemetryAt ? new Date(device.lastTelemetryAt).getTime() : NaN;
  const telemetryAge = refTimeMs - telemetryMs;
  if (!device || device.status !== 'ACTIVE' || !Number.isFinite(telemetryMs) || telemetryAge < 0 || telemetryAge > TELEMETRY_STALE_WINDOW_MS) return { status: PRINTER_STATES.UNKNOWN, isReady: false, agentOnline: true, statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.UNKNOWN], paperStatus: 'UNKNOWN', tonerStatus: 'UNKNOWN', jamStatus: false };
  const state = String(device.healthStatus || 'UNKNOWN').toUpperCase();
  const mapped = { ONLINE: [PRINTER_STATES.ONLINE, true], PAPER_OUT: [PRINTER_STATES.PAPER_OUT, false], JAMMED: [PRINTER_STATES.JAMMED, false], OFFLINE: [PRINTER_STATES.PRINTER_DISCONNECTED, false] }[state];
  if (!mapped) return { status: PRINTER_STATES.UNKNOWN, isReady: false, agentOnline: true, statusMessage: CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.UNKNOWN], paperStatus: 'UNKNOWN', tonerStatus: 'UNKNOWN', jamStatus: false };
  return { status: mapped[0], isReady: mapped[1], agentOnline: true, statusMessage: CUSTOMER_STATUS_MESSAGES[mapped[0]], paperStatus: state === 'PAPER_OUT' ? 'OUT' : 'OK', tonerStatus: 'UNKNOWN', jamStatus: state === 'JAMMED' };
};

const getPrinterDeviceAvailability = async (machineId, printerDeviceId, dbClient = prisma, now = new Date()) => {
  if (!machineId || !printerDeviceId) return null;
  const [machine, device] = await Promise.all([
    dbClient.machine.findUnique({ where: { id: machineId }, select: { id: true, status: true, lastOnline: true } }),
    dbClient.printerDevice.findFirst({ where: { id: printerDeviceId, machineId }, select: { id: true, displayName: true, printerModel: true, status: true, healthStatus: true, lastTelemetryAt: true } })
  ]);
  if (!machine || !device) return null;
  return { machineId: machine.id, printerDeviceId: device.id, name: device.displayName, printerModel: device.printerModel || 'Unknown', lastTelemetryAt: device.lastTelemetryAt ? device.lastTelemetryAt.toISOString() : null, ...computePrinterDeviceAvailability(machine, device, now) };
};

const getMachineAvailability = async (machineId, dbClient = prisma, now = new Date()) => {
  if (!machineId) return null;

  const machine = await dbClient.machine.findUnique({
    where: { id: machineId },
    include: {
      printerStatuses: {
        take: 1,
        orderBy: { timestamp: 'desc' },
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
  computePrinterDeviceAvailability,
  getPrinterDeviceAvailability,
  getMachineAvailability,
};
