const { evaluatePrinterReadiness } = require('./printerStatusMapping');
const ACTIVE_DEVICE_STATUS = 'ACTIVE';
const STATUS_QUERY_STAGGER_MS = 9000;
const VALID_DEVICE_STATUSES = new Set([
  'DISCOVERY_REQUIRED',
  'PENDING_APPROVAL',
  'ACTIVE',
  'DISABLED',
  'MAINTENANCE'
]);

class PrinterFleetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrinterFleetError';
    this.code = code;
  }
}

function normalizeDeviceRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new PrinterFleetError('INVALID_DEVICE_REGISTRY', 'Printer registry contains a malformed device record.');
  }

  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new PrinterFleetError('INVALID_DEVICE_ID', 'Printer registry contains an invalid PrinterDevice ID.');
  }

  const status = typeof record.status === 'string' ? record.status.trim().toUpperCase() : '';
  if (!VALID_DEVICE_STATUSES.has(status)) {
    throw new PrinterFleetError('INVALID_DEVICE_STATUS', `Printer device ${id} has an unsupported lifecycle status.`);
  }

  let windowsPrinterName = null;
  if (record.windowsPrinterName !== null && record.windowsPrinterName !== undefined) {
    if (typeof record.windowsPrinterName !== 'string') {
      throw new PrinterFleetError('INVALID_QUEUE_NAME', `Printer device ${id} has an invalid Windows queue name.`);
    }
    windowsPrinterName = record.windowsPrinterName.trim();
    if (!windowsPrinterName || windowsPrinterName.length > 256 || /[\u0000-\u001f\u007f]/.test(windowsPrinterName)) {
      throw new PrinterFleetError('INVALID_QUEUE_NAME', `Printer device ${id} has an invalid Windows queue name.`);
    }
  }

  const approvedAt = typeof record.approvedAt === 'string' && record.approvedAt.trim()
    ? record.approvedAt.trim()
    : null;

  return {
    id,
    displayName: typeof record.displayName === 'string' ? record.displayName : windowsPrinterName || id,
    windowsPrinterName,
    status,
    approvedAt,
    sortOrder: Number.isFinite(record.sortOrder) ? record.sortOrder : 0
  };
}

/**
 * Maintains an in-memory view of server-registered printers for one Machine.
 *
 * getDeviceRegistry must be backed by the authenticated Agent/Machine channel.
 * Discovery alone is never approval. Only ACTIVE records with approval evidence
 * and an exact queue-name match receive a monitor or can resolve for printing.
 */
class PrinterFleetManager {
  constructor(options = {}) {
    if (typeof options.discoverPrinters !== 'function') {
      throw new PrinterFleetError('DISCOVERY_PROVIDER_REQUIRED', 'A Windows printer discovery provider is required.');
    }
    if (typeof options.getDeviceRegistry !== 'function') {
      throw new PrinterFleetError('REGISTRY_PROVIDER_REQUIRED', 'An authenticated PrinterDevice registry provider is required.');
    }

    this.discoverPrinters = options.discoverPrinters;
    this.getDeviceRegistry = options.getDeviceRegistry;
    this.monitorFactory = typeof options.monitorFactory === 'function'
      ? options.monitorFactory
      : () => null;
    this.maxDevices = Number.isInteger(options.maxDevices) ? options.maxDevices : 10;
    if (this.maxDevices < 1 || this.maxDevices > 10) {
      throw new PrinterFleetError('INVALID_FLEET_LIMIT', 'The supported PrinterGo fleet limit is 1 to 10 devices per PC.');
    }

    this.journal = options.journal || null;
    this.devices = new Map();
    this.monitors = new Map();
    this.discoveredPrinters = [];
    this.lastRefreshAt = null;
    this.statusCheckTimers = new Set();
  }

  cancelPendingStatusChecks() {
    for (const timer of this.statusCheckTimers) clearTimeout(timer);
    this.statusCheckTimers.clear();
  }

  async refresh() {
    // Cancel delayed checks from the previous fleet snapshot before invalidating it.
    this.cancelPendingStatusChecks();

    // A failed discovery/registry refresh must not leave stale print mappings active.
    this.devices.clear();
    this.monitors.clear();
    this.discoveredPrinters = [];
    this.lastRefreshAt = null;

    const [discovered, registry] = await Promise.all([
      this.discoverPrinters(),
      this.getDeviceRegistry()
    ]);

    if (!Array.isArray(discovered) || !Array.isArray(registry)) {
      throw new PrinterFleetError('INVALID_FLEET_RESPONSE', 'Discovery and device registry providers must return arrays.');
    }
    if (registry.length > this.maxDevices) {
      throw new PrinterFleetError(
        'FLEET_LIMIT_EXCEEDED',
        `This Agent supports at most ${this.maxDevices} registered printers per Windows PC.`
      );
    }

    const discoveredByName = new Map();
    for (const printer of discovered) {
      const name = printer && typeof printer.windowsPrinterName === 'string'
        ? printer.windowsPrinterName.trim()
        : '';
      if (!name) {
        throw new PrinterFleetError('INVALID_DISCOVERY_RECORD', 'Discovered printer is missing its exact Windows queue name.');
      }
      const normalizedName = name.toLowerCase();
      if (discoveredByName.has(normalizedName)) {
        throw new PrinterFleetError('DUPLICATE_DISCOVERED_QUEUE', `Duplicate discovered queue: ${name}`);
      }
      discoveredByName.set(normalizedName, { ...printer, windowsPrinterName: name });
    }

    const seenIds = new Set();
    const seenQueueNames = new Set();
    const normalized = registry.map(normalizeDeviceRecord);
    const nextDevices = new Map();
    const nextMonitors = new Map();

    for (const device of normalized) {
      if (seenIds.has(device.id)) {
        throw new PrinterFleetError('DUPLICATE_DEVICE_ID', `Duplicate PrinterDevice ID: ${device.id}`);
      }
      seenIds.add(device.id);

      if (device.windowsPrinterName) {
        const queueKey = device.windowsPrinterName.toLowerCase();
        if (seenQueueNames.has(queueKey)) {
          throw new PrinterFleetError(
            'DUPLICATE_APPROVED_QUEUE',
            `A Windows queue is assigned to more than one PrinterDevice: ${device.windowsPrinterName}`
          );
        }
        seenQueueNames.add(queueKey);
      }

      const discoveredPrinter = device.windowsPrinterName
        ? discoveredByName.get(device.windowsPrinterName.toLowerCase()) || null
        : null;
      const approvalValid = device.status === ACTIVE_DEVICE_STATUS && !!device.approvedAt;
      let canPrint = approvalValid && !!discoveredPrinter;
      let reason = null;

      if (device.status !== ACTIVE_DEVICE_STATUS) {
        reason = 'ADMIN_APPROVAL_REQUIRED';
      } else if (!device.approvedAt) {
        reason = 'APPROVAL_EVIDENCE_MISSING';
      } else if (!device.windowsPrinterName) {
        reason = 'WINDOWS_QUEUE_NOT_BOUND';
      } else if (!discoveredPrinter) {
        reason = 'WINDOWS_QUEUE_NOT_PRESENT';
      } else {
        const readiness = evaluatePrinterReadiness(discoveredPrinter);
        if (!readiness.canPrint) {
          canPrint = false;
          reason = readiness.reason === 'PRINTER_OFFLINE'
            ? 'PRINTER_OFFLINE'
            : (readiness.reason === 'PRINTER_BUSY' ? 'PRINTER_BUSY' : 'PRINTER_ERROR_STATE');
        }
      }

      // Monitoring is diagnostic, not dispatch authorization. Keep a monitor
      // for every approved, exactly matched queue even when its current state
      // is Unknown/offline/error; resolveForPrint still requires canPrint=true.
      if (approvalValid && discoveredPrinter) {
        const monitor = this.monitorFactory({
          printerDevice: device,
          discoveredPrinter,
          printerName: discoveredPrinter.windowsPrinterName,
          journal: this.journal
        });
        if (!monitor || typeof monitor.checkPrinterStatus !== 'function') {
          if (canPrint) {
            canPrint = false;
            reason = 'DEVICE_MONITOR_UNAVAILABLE';
          }
        } else {
          nextMonitors.set(device.id, monitor);
        }
      }

      const view = {
        ...device,
        availability: discoveredPrinter ? 'QUEUE_PRESENT' : 'QUEUE_MISSING',
        canPrint,
        reason,
        discoveredPrinter
      };
      nextDevices.set(device.id, view);
    }

    // Publish a complete, internally consistent snapshot only after all rows pass validation.
    this.devices = nextDevices;
    this.monitors = nextMonitors;
    this.discoveredPrinters = Array.from(discoveredByName.values());
    this.lastRefreshAt = new Date().toISOString();
    return this.listDevices();
  }

  listDevices() {
    return Array.from(this.devices.values())
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((device) => ({ ...device, discoveredPrinter: device.discoveredPrinter ? { ...device.discoveredPrinter } : null }));
  }

  getDiscoveredPrinters() {
    return this.discoveredPrinters.map((printer) => ({ ...printer }));
  }

  getDevice(printerDeviceId) {
    const device = this.devices.get(printerDeviceId);
    return device ? { ...device, discoveredPrinter: device.discoveredPrinter ? { ...device.discoveredPrinter } : null } : null;
  }

  getMonitor(printerDeviceId) {
    return this.monitors.get(printerDeviceId) || null;
  }

  resolveForPrint(printerDeviceId) {
    const device = this.devices.get(printerDeviceId);
    if (!device || !device.canPrint || !device.discoveredPrinter) {
      throw new PrinterFleetError(
        'PRINTER_DEVICE_NOT_APPROVED_OR_AVAILABLE',
        'The requested PrinterDevice is not approved and present on this PC. Refusing physical dispatch.'
      );
    }

    return {
      printerDeviceId: device.id,
      windowsPrinterName: device.discoveredPrinter.windowsPrinterName,
      displayName: device.displayName,
      monitor: this.getMonitor(printerDeviceId)
    };
  }

  checkPrinterStatuses(socket) {
    let checksScheduled = 0;
    let index = 0;
    for (const monitor of this.monitors.values()) {
      if (monitor && typeof monitor.checkPrinterStatus === 'function') {
        const delay = index * STATUS_QUERY_STAGGER_MS;
        if (delay === 0) {
          monitor.checkPrinterStatus(socket);
        } else {
          const timer = setTimeout(() => {
            this.statusCheckTimers.delete(timer);
            if (this.monitors.size && Array.from(this.monitors.values()).includes(monitor)) {
              monitor.checkPrinterStatus(socket);
            }
          }, delay);
          this.statusCheckTimers.add(timer);
        }
        checksScheduled += 1;
        index += 1;
      }
    }
    return checksScheduled;
  }
}

PrinterFleetManager.STATUS_QUERY_STAGGER_MS = STATUS_QUERY_STAGGER_MS;

module.exports = {
  PrinterFleetError,
  PrinterFleetManager,
  normalizeDeviceRecord
};
