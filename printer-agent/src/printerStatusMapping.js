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
 * Blocking vs Warning Policy:
 * - Healthy: 2 (No Error) -> isError=false, isWarning=false, isBlocking=false, canPrint=true
 * - Warnings: 3 (Low Paper), 5 (Low Toner) -> isError=false, isWarning=true, isBlocking=false, canPrint=true
 *   (Warnings indicate consumable supply is low, but the device is physically capable of printing).
 * - Blocking: 0, 1, 4, 6, 7, 8, 9, 10, 11, or unrecognized -> isError=true, isWarning=false, isBlocking=true, canPrint=false
 *   (Device cannot reliably print or physical hardware intervention is required).
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
  // Unrecognized numeric value: do not silently classify as healthy
  return {
    code: stateCode,
    name: 'Unrecognized',
    isError: true,
    isWarning: false,
    isBlocking: true,
    message: 'Printer Error',
    reason: 'PRINTER_ERROR_STATE'
  };
}

module.exports = {
  WIN32_DETECTED_ERROR_STATE,
  interpretDetectedErrorState
};
