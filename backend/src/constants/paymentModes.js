/**
 * Authoritative PrintGo Payment Mode Constants & Default Fallback
 */

const PAYMENT_MODES = Object.freeze({
  CASH_AT_COUNTER: 'CASH_AT_COUNTER',
  DEMO_SIMULATION: 'DEMO_SIMULATION',
  CASHFREE_ONLINE: 'CASHFREE_ONLINE'
});

const DEFAULT_PAYMENT_MODE = PAYMENT_MODES.CASH_AT_COUNTER;

module.exports = {
  PAYMENT_MODES,
  DEFAULT_PAYMENT_MODE
};
