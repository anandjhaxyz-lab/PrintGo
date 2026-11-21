/**
 * PrintGo State Machines
 * 
 * Defines allowed status transitions for PrintJobs and Payments.
 * Prevents invalid state changes (e.g., COMPLETED → PENDING_PAYMENT).
 */

const logger = require('./logger');

const MIN_OPERATOR_REASON_LENGTH = 10;

/**
 * Validates that an operator reason meets UP-04 requirements:
 * String with at least 10 non-whitespace characters.
 * @param {string} reason
 * @returns {{ valid: boolean, sanitized?: string, error?: string }}
 */
const validateOperatorReason = (reason) => {
  if (!reason || typeof reason !== 'string') {
    return {
      valid: false,
      error: 'An operator reason containing at least 10 non-whitespace characters is required.'
    };
  }
  const sanitized = reason.trim();
  const nonWhitespaceLength = sanitized.replace(/\s/g, '').length;
  if (nonWhitespaceLength < MIN_OPERATOR_REASON_LENGTH) {
    return {
      valid: false,
      error: `An operator reason containing at least ${MIN_OPERATOR_REASON_LENGTH} non-whitespace characters is required (received ${nonWhitespaceLength}).`
    };
  }
  return { valid: true, sanitized };
};

// ============================================================
// Print Job State Machine
// ============================================================
//
//  PENDING_PAYMENT ──► WAITING ──► PRINTING ──► COMPLETED
//       │                │            │
//       ▼                ▼            ▼
//    CANCELLED       CANCELLED     FAILED
//                                    │
//                                    ▼
//                                CANCELLED
//
// Explicit Authorized Retry (UP-04 Operator Governed):
//  FAILED ──(Authorized Operator Retry with >= 10 char reason)──► WAITING
//
const PRINT_JOB_TRANSITIONS = {
  'PENDING_PAYMENT': ['WAITING', 'CANCELLED'],
  'WAITING':         ['PRINTING', 'CANCELLED'],
  'PRINTING':        ['COMPLETED', 'FAILED'],
  'COMPLETED':       [],  // Terminal state
  'FAILED':          ['CANCELLED'],  // Normal transitions only allow CANCELLED
  'CANCELLED':       [],  // Terminal state
};

const AUTHORIZED_RETRY_TRANSITIONS = {
  'FAILED': ['WAITING']
};

// ============================================================
// Payment State Machine
// ============================================================
//
//  PENDING ──► SUCCESS ──► REFUNDED
//     │
//     ▼
//   FAILED
//     │
//     ▼
//   EXPIRED
//
const PAYMENT_TRANSITIONS = {
  'PENDING':   ['SUCCESS', 'FAILED'],
  'SUCCESS':   ['REFUNDED'],
  'FAILED':    ['EXPIRED'],
  'REFUNDED':  [],  // Terminal state
  'EXPIRED':   [],  // Terminal state
};

/**
 * Validates whether a status transition is allowed.
 * @param {Object} transitions - The state machine definition
 * @param {string} entityType - Name for logging (e.g., 'PrintJob', 'Payment')
 * @param {string} currentStatus - Current status
 * @param {string} newStatus - Desired new status
 * @returns {boolean} Whether the transition is allowed
 */
const isValidTransition = (transitions, entityType, currentStatus, newStatus) => {
  const allowed = transitions[currentStatus];
  
  if (!allowed) {
    logger.warn(`${entityType}: Unknown current status "${currentStatus}"`);
    return false;
  }
  
  if (!allowed.includes(newStatus)) {
    logger.warn(`${entityType}: Invalid transition "${currentStatus}" → "${newStatus}". Allowed: [${allowed.join(', ')}]`);
    return false;
  }
  
  return true;
};

/**
 * Validate a PrintJob status transition.
 * Supports explicit authorized retry from FAILED -> WAITING when options.authorizedRetry = true.
 */
const isValidJobTransition = (currentStatus, newStatus, options = {}) => {
  if (currentStatus === 'FAILED' && newStatus === 'WAITING') {
    if (options && (options.authorizedRetry === true || options.isAuthorizedRetry === true)) {
      return true;
    }
    logger.warn(`PrintJob: Retry transition "FAILED" → "WAITING" requires explicit operator authorization.`);
    return false;
  }
  return isValidTransition(PRINT_JOB_TRANSITIONS, 'PrintJob', currentStatus, newStatus);
};

/**
 * Validate a Payment status transition.
 */
const isValidPaymentTransition = (currentStatus, newStatus) => {
  return isValidTransition(PAYMENT_TRANSITIONS, 'Payment', currentStatus, newStatus);
};

/**
 * All valid PrintJob statuses.
 */
const JOB_STATUSES = Object.keys(PRINT_JOB_TRANSITIONS);

/**
 * All valid Payment statuses.
 */
const PAYMENT_STATUSES = Object.keys(PAYMENT_TRANSITIONS);

module.exports = {
  PRINT_JOB_TRANSITIONS,
  AUTHORIZED_RETRY_TRANSITIONS,
  MIN_OPERATOR_REASON_LENGTH,
  validateOperatorReason,
  PAYMENT_TRANSITIONS,
  isValidJobTransition,
  isValidPaymentTransition,
  JOB_STATUSES,
  PAYMENT_STATUSES,
};
