const os = require('os');
const { classifyConnection } = require('./spooler');

const WINDOWS_PRINTER_DISCOVERY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$printers = @(Get-CimInstance -ClassName Win32_Printer | Select-Object Name, DriverName, PortName, PrinterStatus, ExtendedPrinterStatus, DetectedErrorState, ExtendedDetectedErrorState, WorkOffline, Shared, Network, Default)",
  "if ($printers.Count -eq 0) { '[]' } else { $printers | ConvertTo-Json -Depth 4 -Compress }"
].join('; ');

const MIN_DISCOVERY_TIMEOUT_MS = 1000;
const MAX_DISCOVERY_TIMEOUT_MS = 300000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30000;

function normalizeDiscoveryTimeoutMs(timeoutMs, defaultMs = DEFAULT_DISCOVERY_TIMEOUT_MS) {
  if (typeof timeoutMs === 'string') {
    const trimmed = timeoutMs.trim();
    if (!/^\d+$/.test(trimmed)) return defaultMs;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isSafeInteger(parsed) && parsed >= MIN_DISCOVERY_TIMEOUT_MS && parsed <= MAX_DISCOVERY_TIMEOUT_MS) {
      return parsed;
    }
    return defaultMs;
  }
  if (typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs >= MIN_DISCOVERY_TIMEOUT_MS && timeoutMs <= MAX_DISCOVERY_TIMEOUT_MS) {
    return timeoutMs;
  }
  return defaultMs;
}

let inFlightDiscoveryPromise = null;
let inFlightExecFile = null;

class PrinterDiscoveryError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'PrinterDiscoveryError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function getField(record, fieldName) {
  if (!record || typeof record !== 'object') return undefined;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === fieldName.toLowerCase());
  return key ? record[key] : undefined;
}

function nullableString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
  }
  return null;
}

function normalizePrinterRecord(record) {
  const name = nullableString(getField(record, 'Name'));
  if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new PrinterDiscoveryError(
      'INVALID_PRINTER_RECORD',
      'Windows printer discovery returned a missing or invalid queue name.'
    );
  }

  const driverName = nullableString(getField(record, 'DriverName'));
  const portName = nullableString(getField(record, 'PortName'));

  return {
    windowsPrinterName: name,
    driverName,
    portName,
    connectionType: classifyConnection(portName),
    printerStatus: getField(record, 'PrinterStatus') ?? null,
    extendedPrinterStatus: getField(record, 'ExtendedPrinterStatus') ?? null,
    detectedErrorState: getField(record, 'DetectedErrorState') ?? null,
    extendedDetectedErrorState: getField(record, 'ExtendedDetectedErrorState') ?? null,
    workOffline: parseBoolean(getField(record, 'WorkOffline')),
    shared: parseBoolean(getField(record, 'Shared')),
    network: parseBoolean(getField(record, 'Network')),
    isDefault: parseBoolean(getField(record, 'Default'))
  };
}

function parseDiscoveryOutput(stdout) {
  const raw = typeof stdout === 'string' ? stdout.trim() : '';
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PrinterDiscoveryError(
      'INVALID_DISCOVERY_OUTPUT',
      'Windows printer discovery returned invalid JSON. No printer was approved or activated.',
      error
    );
  }

  if (parsed === null || parsed === undefined) return [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const printers = rows.map(normalizePrinterRecord);
  const seen = new Set();

  for (const printer of printers) {
    const key = printer.windowsPrinterName.toLowerCase();
    if (seen.has(key)) {
      throw new PrinterDiscoveryError(
        'DUPLICATE_PRINTER_QUEUE',
        `Windows discovery returned a duplicate queue name: ${printer.windowsPrinterName}`
      );
    }
    seen.add(key);
  }

  return printers;
}

/**
 * Discover Windows print queues only. This is informational discovery:
 * it never approves a queue and never sends a print job.
 */
function discoverWindowsPrinters(options = {}) {
  const platform = options.platform || os.platform();
  const arch = options.arch || (platform === 'win32' && os.platform() !== 'win32' ? 'x64' : os.arch());
  const release = options.release !== undefined
    ? options.release
    : (platform === 'win32' && os.platform() !== 'win32' ? '10.0.22631' : os.release());
  const majorVersion = parseInt(String(release || '').split('.')[0], 10);
  const isWindows10Or11 = Number.isFinite(majorVersion) && majorVersion >= 10;
  const execFile = options.execFile;
  const timeoutMs = normalizeDiscoveryTimeoutMs(options.timeoutMs);

  if (platform !== 'win32' || arch !== 'x64' || !isWindows10Or11) {
    return Promise.reject(new PrinterDiscoveryError(
      'UNSUPPORTED_PLATFORM',
      'Windows printer discovery is supported only on Windows 10/11 x64.'
    ));
  }

  if (typeof execFile !== 'function') {
    return Promise.reject(new PrinterDiscoveryError(
      'EXEC_FILE_REQUIRED',
      'A child_process.execFile implementation is required for Windows discovery.'
    ));
  }

  // Prevent overlapping discovery subprocesses by coalescing concurrent calls with the same execFile
  if (options.coalesce !== false && inFlightDiscoveryPromise && inFlightExecFile === execFile) {
    return inFlightDiscoveryPromise;
  }

  const discoveryPromise = new Promise((resolve, reject) => {
    let childProcess = null;
    try {
      childProcess = execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          WINDOWS_PRINTER_DISCOVERY_SCRIPT
        ],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error) {
            // Defensive cleanup of timed-out or hung subprocess
            if (childProcess && !childProcess.killed && typeof childProcess.kill === 'function') {
              try {
                childProcess.kill('SIGKILL');
              } catch (_) {}
            }

            const isTimeout = !!(error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT' || error.timedOut);
            const failureMessage = isTimeout
              ? `Windows printer discovery timed out after ${timeoutMs}ms.`
              : `Could not enumerate Windows printer queues: ${error.message}`;

            reject(new PrinterDiscoveryError(
              'WINDOWS_DISCOVERY_FAILED',
              failureMessage,
              error
            ));
            return;
          }

          try {
            resolve(parseDiscoveryOutput(stdout));
          } catch (parseError) {
            reject(parseError);
          }
        }
      );
    } catch (invocationError) {
      reject(new PrinterDiscoveryError(
        'WINDOWS_DISCOVERY_FAILED',
        `Could not enumerate Windows printer queues: ${invocationError.message}`,
        invocationError
      ));
    }
  });

  if (options.coalesce !== false) {
    inFlightDiscoveryPromise = discoveryPromise;
    inFlightExecFile = execFile;
    const cleanup = () => {
      if (inFlightDiscoveryPromise === discoveryPromise) {
        inFlightDiscoveryPromise = null;
        inFlightExecFile = null;
      }
    };
    discoveryPromise.then(cleanup, cleanup);
  }

  return discoveryPromise;
}

module.exports = {
  WINDOWS_PRINTER_DISCOVERY_SCRIPT,
  MIN_DISCOVERY_TIMEOUT_MS,
  MAX_DISCOVERY_TIMEOUT_MS,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  normalizeDiscoveryTimeoutMs,
  PrinterDiscoveryError,
  discoverWindowsPrinters,
  parseDiscoveryOutput
};
