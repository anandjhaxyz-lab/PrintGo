/**
 * Win32_Printer DetectedErrorState mapping & policy:
 * https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-printer
 *
 * Values:
 *  0 = Unknown
 *  1 = Other
 *  2 = No Error
 *  3 = Low Paper
 *  4 = No Paper
 *  5 = Low Toner
 *  6 = No Toner
 *  7 = Door Open
 *  8 = Jammed
 *  9 = Offline
 * 10 = Service Requested
 * 11 = Output Bin Full
 *
 * Contextual Health Policy:
 * - Confirmed Healthy: 2 (No Error) -> isError=false, isWarning=false, isBlocking=false, canPrint=true
 * - Warnings: 3 (Low Paper), 5 (Low Toner) -> isError=false, isWarning=true, isBlocking=false, canPrint=true
 * - Confirmed Blocking Errors: 1 (Other), 4 (No Paper), 6 (No Toner), 7 (Door Open),
 *   8 (Jammed), 9 (Offline), 10 (Service Requested), 11 (Output Bin Full) -> isError=true, isBlocking=true
 * - Unknown State (0):
 *   Treated as UNKNOWN, not automatically as a confirmed hardware fault.
 *   Non-blocking for monitor initialization only when:
 *     1) Queue is NOT offline (workOffline === false)
 *     2) Queue state is consistent with Ready/Idle (3) or Printing (4)
 *     3) For Network printers, TCP connectivity to printer endpoint succeeds.
 *   Does not convert unknown state into false claim that paper or toner is OK.
 */

const WIN32_DETECTED_ERROR_STATE = Object.freeze({
  0: { code: 0, name: 'Unknown', isError: false, isWarning: false, isBlocking: false, isUnknown: true, message: 'Printer State Unknown', reason: 'PRINTER_STATE_UNKNOWN' },
  1: { code: 1, name: 'Other', isError: true, isWarning: false, isBlocking: true, isUnknown: false, message: 'Printer Error', reason: 'PRINTER_ERROR_STATE' },
  2: { code: 2, name: 'No Error', isError: false, isWarning: false, isBlocking: false, isUnknown: false, message: '', reason: null },
  3: { code: 3, name: 'Low Paper', isError: false, isWarning: true, isBlocking: false, isUnknown: false, message: 'Low Paper', reason: null },
  4: { code: 4, name: 'No Paper', isError: true, isWarning: false, isBlocking: true, isUnknown: false, message: 'Out of Paper', reason: 'PRINTER_NO_PAPER' },
  5: { code: 5, name: 'Low Toner', isError: false, isWarning: true, isBlocking: false, isUnknown: false, message: 'Low Toner', reason: null },
  6: { code: 6, name: 'No Toner', isError: true, isWarning: false, isBlocking: true, isUnknown: false, message: 'No Toner', reason: 'PRINTER_NO_TONER' },
  7: { code: 7, name: 'Door Open', isError: true, isWarning: false, isBlocking: true, isUnknown: false, message: 'Door Open', reason: 'PRINTER_DOOR_OPEN' },
  8: { code: 8, name: 'Jammed', isError: true, isWarning: false, isBlocking: true, isUnknown: false, message: 'Paper Jam', reason: 'PRINTER_PAPER_JAM' },
  9: { code: 9, name: 'Offline', isError: true, isWarning: false, isBlocking: true, isUnknown: false, message: 'Printer Offline', reason: 'PRINTER_OFFLINE' },
  10: { code: 10, name: 'Service Requested', isError: true, isWarning: false, isBlocking: true, isUnknown: false, message: 'Service Requested', reason: 'PRINTER_SERVICE_REQUESTED' },
  11: { code: 11, name: 'Output Bin Full', isError: true, isWarning: false, isBlocking: true, isUnknown: false, message: 'Output Bin Full', reason: 'PRINTER_OUTPUT_BIN_FULL' }
});

function interpretDetectedErrorState(rawState) {
  if (rawState === null || rawState === undefined || rawState === '') {
    return null;
  }
  const numericState = Number(rawState);
  if (!Number.isFinite(numericState)) {
    return null;
  }
  const stateCode = Math.trunc(numericState);
  if (Object.prototype.hasOwnProperty.call(WIN32_DETECTED_ERROR_STATE, stateCode)) {
    return WIN32_DETECTED_ERROR_STATE[stateCode];
  }
  // Unrecognized numeric value: fail closed as error
  return {
    code: stateCode,
    name: 'Unrecognized',
    isError: true,
    isWarning: false,
    isBlocking: true,
    isUnknown: false,
    message: 'Printer Error',
    reason: 'PRINTER_ERROR_STATE'
  };
}

/**
 * Evaluates contextual printer health combining WMI DetectedErrorState,
 * WorkOffline attribute, Windows queue status (PrinterStatus), connection type,
 * and optional network connectivity probe result.
 *
 * @param {Object} context
 * @param {number|null} context.detectedErrorState - WMI DetectedErrorState (0..11)
 * @param {boolean} [context.workOffline=false] - WMI WorkOffline flag
 * @param {number|null} [context.printerStatus=null] - WMI PrinterStatus (3=Idle, 4=Printing, etc.)
 * @param {'USB'|'Network'|'Unknown'} [context.connectionType='Unknown']
 * @param {boolean|null} [context.networkOnline=null] - Result of TCP connectivity check (for Network printers)
 * @param {string|null} [context.networkError=null] - Error code from TCP connectivity check
 * @returns {{
 *   canPrint: boolean,
 *   isError: boolean,
 *   isWarning: boolean,
 *   isUnknown: boolean,
 *   message: string,
 *   reason: string | null,
 *   paperStatus: 'OK' | 'LOW' | 'OUT' | 'UNKNOWN',
 *   tonerStatus: 'OK' | 'LOW' | 'OUT' | 'UNKNOWN'
 * }}
 */
function evaluateContextualPrinterHealth(context = {}) {
  const {
    detectedErrorState = null,
    workOffline = false,
    printerStatus = null,
    connectionType = 'Unknown',
    networkOnline = null,
    networkError = null
  } = context;

  // 1. WorkOffline is strictly blocking under all conditions
  if (workOffline === true) {
    return {
      canPrint: false,
      isError: true,
      isWarning: false,
      isUnknown: false,
      message: 'Printer Offline',
      reason: 'PRINTER_OFFLINE',
      paperStatus: 'UNKNOWN',
      tonerStatus: 'UNKNOWN'
    };
  }

  // 2. Evaluate explicit WMI error state if present
  const errorState = interpretDetectedErrorState(detectedErrorState);

  // 2a. Explicit hardware errors (1, 4, 6, 7, 8, 9, 10, 11, or unrecognized)
  if (errorState && errorState.isBlocking) {
    return {
      canPrint: false,
      isError: true,
      isWarning: false,
      isUnknown: false,
      message: errorState.message,
      reason: errorState.code === 9 ? 'PRINTER_OFFLINE' : (errorState.reason || 'PRINTER_ERROR_STATE'),
      diagnosticReason: errorState.reason || 'PRINTER_ERROR_STATE',
      paperStatus: errorState.code === 4 ? 'OUT' : 'UNKNOWN',
      tonerStatus: errorState.code === 6 ? 'OUT' : 'UNKNOWN'
    };
  }

  // 2b. Confirmed healthy (code 2: No Error)
  if (errorState && errorState.code === 2) {
    return {
      canPrint: true,
      isError: false,
      isWarning: false,
      isUnknown: false,
      message: '',
      reason: null,
      paperStatus: 'OK',
      tonerStatus: 'OK'
    };
  }

  // 2c. Non-blocking consumable warnings (code 3: Low Paper, code 5: Low Toner)
  if (errorState && (errorState.code === 3 || errorState.code === 5)) {
    return {
      canPrint: true,
      isError: false,
      isWarning: true,
      isUnknown: false,
      message: errorState.message,
      reason: null,
      paperStatus: errorState.code === 3 ? 'LOW' : 'OK',
      tonerStatus: errorState.code === 5 ? 'LOW' : 'OK'
    };
  }

  // 3. WMI Unknown state (code 0) or unpopulated state (null/undefined)
  // Check queue status: must be consistent with Ready/Idle (3) or Printing (4) if reported
  if (printerStatus !== null && printerStatus !== undefined) {
    const numericStatus = Number(printerStatus);
    // In Win32_Printer: 3 = Idle, 4 = Printing
    if (numericStatus !== 3 && numericStatus !== 4) {
      return {
        canPrint: false,
        isError: true,
        isWarning: false,
        isUnknown: true,
        message: 'Printer Queue Not Ready',
        reason: 'PRINTER_QUEUE_NOT_READY',
        paperStatus: 'UNKNOWN',
        tonerStatus: 'UNKNOWN'
      };
    }
  }

  // 4. Network printer specific connectivity requirements
  if (connectionType === 'Network') {
    // If a required network check was performed and failed
    if (networkOnline === false) {
      const isTimeout = networkError === 'TIMED_OUT';
      return {
        canPrint: false,
        isError: true,
        isWarning: false,
        isUnknown: false,
        message: isTimeout ? 'Network Connectivity Timeout' : 'Network Printer Unreachable',
        reason: isTimeout ? 'NETWORK_TIMEOUT' : 'NETWORK_UNREACHABLE',
        paperStatus: 'UNKNOWN',
        tonerStatus: 'UNKNOWN'
      };
    }

    // Network printer with confirmed TCP connectivity (or pending non-blocking verification)
    // Preserves distinguishable diagnostic reason 'PRINTER_STATE_UNKNOWN'
    // Does NOT falsely claim paper or toner is OK
    return {
      canPrint: true,
      isError: false,
      isWarning: false,
      isUnknown: true,
      message: '',
      reason: 'PRINTER_STATE_UNKNOWN',
      paperStatus: 'UNKNOWN',
      tonerStatus: 'UNKNOWN'
    };
  }

  // 5. USB printer with WMI Unknown:
  // Queue is not offline, queue is ready/idle. Eligible for monitor initialization.
  // Preserves distinguishable diagnostic reason and UNKNOWN consumable state.
  return {
    canPrint: true,
    isError: false,
    isWarning: false,
    isUnknown: true,
    message: '',
    reason: 'PRINTER_STATE_UNKNOWN',
    paperStatus: 'UNKNOWN',
    tonerStatus: 'UNKNOWN'
  };
}

module.exports = {
  WIN32_DETECTED_ERROR_STATE,
  interpretDetectedErrorState,
  evaluateContextualPrinterHealth
};
