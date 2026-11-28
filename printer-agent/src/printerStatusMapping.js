/**
 * Microsoft Win32_Printer status interpretation & policy.
 * Reference: https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-printer
 *
 * Windows WMI / CIM Driver Behavior:
 * On Windows 10/11, standard OEM print drivers (Canon, HP, Epson) default to
 * DetectedErrorState = 0 ("Unknown") and ExtendedDetectedErrorState = 0 ("Unknown")
 * when the printer is healthy and idle, rather than explicitly emitting 2 ("No Error").
 * ExtendedPrinterStatus is similarly reported as 2 ("Unknown" / not reported by driver)
 * while PrinterStatus is 3 ("Idle").
 *
 * Safe Mapping Policy:
 * - When interpreted alone, DetectedErrorState = 0 remains blocking/unknown because
 *   in isolation it carries no proof of idle health.
 * - Only evaluatePrinterReadiness(fullTelemetry) may accept code 0 as healthy, and ONLY
 *   when corroborated by WorkOffline === false, PrinterStatus === 3 (Idle), and
 *   ExtendedPrinterStatus === 2 or 3.
 * - Missing, null, whitespace, fractional/decimal, non-numeric or contradictory telemetry
 *   fails closed.
 * - Genuine error states (codes 1, 4, 6, 7, 8, 9, 10, 11) remain strictly blocking.
 * - Warnings (codes 3 Low Paper, 5 Low Toner) set isWarning=true without blocking dispatch.
 */

const WIN32_DETECTED_ERROR_STATE = Object.freeze({
  0: { code: 0, name: 'Unknown', isError: true, isWarning: false, isBlocking: true, message: 'Printer State Unknown', reason: 'PRINTER_STATE_UNKNOWN' },
  1: { code: 1, name: 'Other', isError: true, isWarning: false, isBlocking: true, message: 'Printer Error', reason: 'PRINTER_ERROR_STATE' },
  2: { code: 2, name: 'No Error', isError: false, isWarning: false, isBlocking: false, message: '', reason: null },
  3: { code: 3, name: 'Low Paper', isError: false, isWarning: true, isBlocking: false, message: 'Low Paper', reason: null },
  4: { code: 4, name: 'No Paper', isError: true, isWarning: false, isBlocking: true, message: 'Out of Paper', reason: 'PRINTER_NO_PAPER' },
  5: { code: 5, name: 'Low Toner', isError: false, isWarning: true, isBlocking: false, message: 'Low Toner', reason: null },
  6: { code: 6, name: 'No Toner', isError: true, isWarning: false, isBlocking: true, message: 'No Toner', reason: 'PRINTER_NO_TONER' },
  7: { code: 7, name: 'Door Open', isError: true, isWarning: false, isBlocking: true, message: 'Door Open', reason: 'PRINTER_DOOR_OPEN' },
  8: { code: 8, name: 'Jammed', isError: true, isWarning: false, isBlocking: true, message: 'Paper Jam', reason: 'PRINTER_PAPER_JAM' },
  9: { code: 9, name: 'Offline', isError: true, isWarning: false, isBlocking: true, message: 'Printer Offline', reason: 'PRINTER_OFFLINE' },
  10: { code: 10, name: 'Service Requested', isError: true, isWarning: false, isBlocking: true, message: 'Service Requested', reason: 'PRINTER_SERVICE_REQUESTED' },
  11: { code: 11, name: 'Output Bin Full', isError: true, isWarning: false, isBlocking: true, message: 'Output Bin Full', reason: 'PRINTER_OUTPUT_BIN_FULL' }
});

const WIN32_EXTENDED_DETECTED_ERROR_STATE = Object.freeze({
  0: { code: 0, name: 'Unknown', isError: true, isWarning: false, isBlocking: true, message: 'Printer State Unknown', reason: 'PRINTER_STATE_UNKNOWN' },
  1: { code: 1, name: 'Other', isError: true, isWarning: false, isBlocking: true, message: 'Printer Error', reason: 'PRINTER_ERROR_STATE' },
  2: { code: 2, name: 'No Error', isError: false, isWarning: false, isBlocking: false, message: '', reason: null },
  3: { code: 3, name: 'Low Paper', isError: false, isWarning: true, isBlocking: false, message: 'Low Paper', reason: null },
  4: { code: 4, name: 'No Paper', isError: true, isWarning: false, isBlocking: true, message: 'Out of Paper', reason: 'PRINTER_NO_PAPER' },
  5: { code: 5, name: 'Low Toner', isError: false, isWarning: true, isBlocking: false, message: 'Low Toner', reason: null },
  6: { code: 6, name: 'No Toner', isError: true, isWarning: false, isBlocking: true, message: 'No Toner', reason: 'PRINTER_NO_TONER' },
  7: { code: 7, name: 'Door Open', isError: true, isWarning: false, isBlocking: true, message: 'Door Open', reason: 'PRINTER_DOOR_OPEN' },
  8: { code: 8, name: 'Jammed', isError: true, isWarning: false, isBlocking: true, message: 'Paper Jam', reason: 'PRINTER_PAPER_JAM' },
  9: { code: 9, name: 'Service Requested', isError: true, isWarning: false, isBlocking: true, message: 'Service Requested', reason: 'PRINTER_SERVICE_REQUESTED' },
  10: { code: 10, name: 'Output Bin Full', isError: true, isWarning: false, isBlocking: true, message: 'Output Bin Full', reason: 'PRINTER_OUTPUT_BIN_FULL' },
  11: { code: 11, name: 'Paper Problem', isError: true, isWarning: false, isBlocking: true, message: 'Paper Problem', reason: 'PRINTER_PAPER_PROBLEM' },
  12: { code: 12, name: 'Cannot Print Page', isError: true, isWarning: false, isBlocking: true, message: 'Cannot Print Page', reason: 'PRINTER_CANNOT_PRINT_PAGE' },
  13: { code: 13, name: 'User Intervention Required', isError: true, isWarning: false, isBlocking: true, message: 'User Intervention Required', reason: 'PRINTER_USER_INTERVENTION' },
  14: { code: 14, name: 'Out of Memory', isError: true, isWarning: false, isBlocking: true, message: 'Printer Out of Memory', reason: 'PRINTER_OUT_OF_MEMORY' },
  15: { code: 15, name: 'Server Unknown', isError: true, isWarning: false, isBlocking: true, message: 'Printer Server Unknown', reason: 'PRINTER_SERVER_UNKNOWN' }
});

function parseStrictInteger(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) return null;
    return raw;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || !/^-?\d+$/.test(trimmed)) return null;
    const num = Number(trimmed);
    if (!Number.isFinite(num) || !Number.isInteger(num)) return null;
    return num;
  }
  return null;
}

function interpret(raw, table) {
  const code = parseStrictInteger(raw);
  if (code === null) return null;
  if (Object.prototype.hasOwnProperty.call(table, code)) {
    return table[code];
  }
  return {
    code,
    name: 'Unrecognized',
    isError: true,
    isWarning: false,
    isBlocking: true,
    message: 'Printer Error',
    reason: 'PRINTER_ERROR_STATE'
  };
}

function interpretDetectedErrorState(raw) {
  return interpret(raw, WIN32_DETECTED_ERROR_STATE);
}

function interpretExtendedDetectedErrorState(raw) {
  return interpret(raw, WIN32_EXTENDED_DETECTED_ERROR_STATE);
}

function unknownState(label) {
  return {
    code: null,
    name: 'Unknown',
    isError: true,
    isWarning: false,
    isBlocking: true,
    message: label + ' Unknown',
    reason: 'PRINTER_STATE_UNKNOWN'
  };
}

function getFieldValue(record, camelKey, pascalKey) {
  if (!record || typeof record !== 'object') return undefined;
  if (record[camelKey] !== undefined) return record[camelKey];
  if (pascalKey && record[pascalKey] !== undefined) return record[pascalKey];
  return undefined;
}

/**
 * Evaluates full printer telemetry and returns whether the printer is ready to print.
 *
 * Strict Corroboration Rules:
 * 1. WorkOffline must be explicitly false (boolean).
 * 2. PrinterStatus must be 3 (Idle).
 * 3. ExtendedPrinterStatus must be 2 (Unknown / driver default) or 3 (Idle).
 * 4. DetectedErrorState and ExtendedDetectedErrorState must be valid non-blocking codes.
 *    Only in this corroborated context is code 0 ("Unknown") accepted as non-blocking idle.
 * 5. Any missing, whitespace, decimal, busy, paused, offline, or genuine error condition
 *    strictly fails closed.
 *
 * @param {Object} record Telemetry record containing status fields
 * @returns {{canPrint: boolean, isError: boolean, isWarning: boolean, reason: string|null, message: string}}
 */
function evaluatePrinterReadiness(record = {}) {
  // 1. WorkOffline verification
  const workOffline = getFieldValue(record, 'workOffline', 'WorkOffline');
  if (workOffline === true) {
    return { canPrint: false, isError: true, isWarning: false, reason: 'PRINTER_OFFLINE', message: 'Printer Offline' };
  }
  if (workOffline !== false) {
    return { canPrint: false, isError: true, isWarning: false, reason: 'PRINTER_STATE_UNKNOWN', message: 'Printer WorkOffline State Unknown' };
  }

  // 2. PrinterStatus verification (must be numeric 3 Idle)
  const rawPrinterStatus = getFieldValue(record, 'printerStatus', 'PrinterStatus');
  const printerStatusCode = parseStrictInteger(rawPrinterStatus);
  if (printerStatusCode === null) {
    return { canPrint: false, isError: true, isWarning: false, reason: 'PRINTER_STATE_UNKNOWN', message: 'Printer Status Unknown' };
  }
  if (printerStatusCode !== 3) {
    const isBusy = printerStatusCode === 4 || printerStatusCode === 5;
    return {
      canPrint: false,
      isError: true,
      isWarning: false,
      reason: isBusy ? 'PRINTER_BUSY' : 'PRINTER_STATUS_NOT_IDLE',
      message: isBusy ? 'Printer Busy' : 'Printer Status Not Verified'
    };
  }

  // 3. ExtendedPrinterStatus verification (must be 2 Unknown/Default or 3 Idle)
  const rawExtendedPrinterStatus = getFieldValue(record, 'extendedPrinterStatus', 'ExtendedPrinterStatus');
  const extendedPrinterStatusCode = parseStrictInteger(rawExtendedPrinterStatus);
  if (extendedPrinterStatusCode === null) {
    return { canPrint: false, isError: true, isWarning: false, reason: 'PRINTER_STATE_UNKNOWN', message: 'Extended Printer Status Unknown' };
  }
  const isBusyExt = extendedPrinterStatusCode === 4 || extendedPrinterStatusCode === 5 ||
    extendedPrinterStatusCode === 10 || extendedPrinterStatusCode === 12 ||
    extendedPrinterStatusCode === 13 || extendedPrinterStatusCode === 17;
  if (isBusyExt) {
    return { canPrint: false, isError: true, isWarning: false, reason: 'PRINTER_BUSY', message: 'Printer Busy' };
  }
  if (extendedPrinterStatusCode === 7) {
    return { canPrint: false, isError: true, isWarning: false, reason: 'PRINTER_OFFLINE', message: 'Printer Offline' };
  }
  if (extendedPrinterStatusCode === 8) {
    return { canPrint: false, isError: true, isWarning: false, reason: 'PRINTER_PAUSED', message: 'Printer Paused' };
  }
  if (extendedPrinterStatusCode !== 2 && extendedPrinterStatusCode !== 3) {
    return { canPrint: false, isError: true, isWarning: false, reason: 'PRINTER_STATUS_NOT_IDLE', message: 'Printer Status Not Verified' };
  }

  // 4. DetectedErrorState and ExtendedDetectedErrorState verification
  const rawDetected = getFieldValue(record, 'detectedErrorState', 'DetectedErrorState');
  const rawExtendedDetected = getFieldValue(record, 'extendedDetectedErrorState', 'ExtendedDetectedErrorState');

  const detectedCode = parseStrictInteger(rawDetected);
  if (detectedCode === null) {
    return { canPrint: false, isError: true, isWarning: false, reason: 'PRINTER_STATE_UNKNOWN', message: 'Detected Error State Unknown' };
  }

  const extendedDetectedCode = parseStrictInteger(rawExtendedDetected);
  if (extendedDetectedCode === null) {
    return { canPrint: false, isError: true, isWarning: false, reason: 'PRINTER_STATE_UNKNOWN', message: 'Extended Detected Error State Unknown' };
  }

  const detected = interpretDetectedErrorState(detectedCode);
  const extendedError = interpretExtendedDetectedErrorState(extendedDetectedCode);

  // In this corroborated idle context (WorkOffline=false, PrinterStatus=3, ExtendedPrinterStatus=2|3),
  // explicit code 0 ("Unknown / No Error Reported") is recognized as non-blocking idle.
  const detectedIsBlocking = detectedCode === 0 ? false : detected.isBlocking;
  const extendedIsBlocking = extendedDetectedCode === 0 ? false : extendedError.isBlocking;

  if (detectedIsBlocking) {
    return { canPrint: false, isError: true, isWarning: false, reason: detected.reason, message: detected.message };
  }
  if (extendedIsBlocking) {
    return { canPrint: false, isError: true, isWarning: false, reason: extendedError.reason, message: extendedError.message };
  }

  const isWarning = Boolean(detected.isWarning || extendedError.isWarning);
  let message = '';
  if (detectedIsBlocking || detected.isWarning) {
    message = detected.message;
  } else if (extendedIsBlocking || extendedError.isWarning) {
    message = extendedError.message;
  }

  return {
    canPrint: true,
    isError: false,
    isWarning,
    reason: null,
    message
  };
}

module.exports = {
  WIN32_DETECTED_ERROR_STATE,
  WIN32_EXTENDED_DETECTED_ERROR_STATE,
  parseStrictInteger,
  interpretDetectedErrorState,
  interpretExtendedDetectedErrorState,
  evaluatePrinterReadiness
};
