const crypto = require('crypto');

/**
 * Staging Demo Payment Authorization Guard
 *
 * Enforces strict environment boundaries for simulated payments:
 * Demo Payment is permitted ONLY when ALL of the following conditions match:
 * 1. APP_ENV === 'staging'
 * 2. ENABLE_DEMO_PAYMENT === 'true'
 * 3. RENDER === 'true'
 * 4. RENDER_SERVICE_ID === 'srv-dbqpapon74is73csbc80'
 * 5. RENDER_SERVICE_NAME === 'printgo-backend-staging'
 * 6. RENDER_GIT_BRANCH === 'feature/printgo-production-readiness'
 *
 * Fail closed if any condition is missing, falsy, or mismatched.
 * Never uses NODE_ENV because Render services default to NODE_ENV=production.
 * Production render.yaml must remain demo-disabled.
 */

const STAGING_SERVICE_ID = 'srv-dbqpapon74is73csbc80';
const STAGING_SERVICE_NAME = 'printgo-backend-staging';
const STAGING_GIT_BRANCH = 'feature/printgo-production-readiness';

// Rate limiting in-memory store: key -> { count: number, firstAttemptAt: number, lastAttemptAt: number }
const failedAttemptsMap = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Evaluates whether Demo Payment is authorized for the given environment.
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
const isDemoPaymentPermitted = (env = process.env) => {
  if (!env || typeof env !== 'object') return false;

  const appEnv = String(env.APP_ENV || '').trim();
  const enableDemo = String(env.ENABLE_DEMO_PAYMENT || '').trim();
  const isRender = String(env.RENDER || '').trim();
  const serviceId = String(env.RENDER_SERVICE_ID || '').trim();
  const serviceName = String(env.RENDER_SERVICE_NAME || '').trim();
  const gitBranch = String(env.RENDER_GIT_BRANCH || '').trim();

  return (
    appEnv === 'staging' &&
    enableDemo === 'true' &&
    isRender === 'true' &&
    serviceId === STAGING_SERVICE_ID &&
    serviceName === STAGING_SERVICE_NAME &&
    gitBranch === STAGING_GIT_BRANCH
  );
};

/**
 * Validates the demo payment access code using timingSafeEqual.
 * Never logs or returns the access code.
 *
 * @param {string} providedCode
 * @param {string} [expectedCode=process.env.DEMO_PAYMENT_ACCESS_CODE]
 * @returns {boolean}
 */
/**
 * Controls whether the Staging demo flow asks the operator/customer for an access code.
 * Defaults to required. Only the exact value "false" disables the prompt/check.
 * The demo endpoint remains protected by isDemoPaymentPermitted() and session ownership.
 */
const isDemoAccessCodeRequired = (env = process.env) => {
  if (!env || typeof env !== 'object') return true;
  return String(env.DEMO_PAYMENT_REQUIRE_ACCESS_CODE ?? 'true').trim().toLowerCase() !== 'false';
};

/**
 * Validates the demo payment access code using timingSafeEqual.
 * Never logs or returns the access code.
 *
 * @param {string} providedCode
 * @param {string} [expectedCode=process.env.DEMO_PAYMENT_ACCESS_CODE]
 * @returns {boolean}
 */
const verifyDemoAccessCode = (providedCode, expectedCode = process.env.DEMO_PAYMENT_ACCESS_CODE) => {
  if (typeof providedCode !== 'string' || !providedCode.trim()) {
    return false;
  }
  if (typeof expectedCode !== 'string' || !expectedCode.trim()) {
    return false; // Fail closed if DEMO_PAYMENT_ACCESS_CODE is not configured
  }

  // Hash both inputs to fixed 32-byte buffers to prevent length leakage and timing discrepancies
  const hashProvided = crypto.createHash('sha256').update(providedCode.trim()).digest();
  const hashExpected = crypto.createHash('sha256').update(expectedCode.trim()).digest();

  return crypto.timingSafeEqual(hashProvided, hashExpected);
};

/**
 * Checks if the given session/IP key is currently rate-limited due to excessive failed attempts.
 * @param {string} key
 * @param {number} [maxAttempts=MAX_FAILED_ATTEMPTS]
 * @param {number} [windowMs=RATE_LIMIT_WINDOW_MS]
 * @returns {boolean}
 */
const isDemoAccessRateLimited = (key, maxAttempts = MAX_FAILED_ATTEMPTS, windowMs = RATE_LIMIT_WINDOW_MS) => {
  if (!key) return false;
  const record = failedAttemptsMap.get(key);
  if (!record) return false;

  const now = Date.now();
  if (now - record.firstAttemptAt > windowMs) {
    failedAttemptsMap.delete(key);
    return false;
  }

  return record.count >= maxAttempts;
};

/**
 * Records a failed access code attempt for the key.
 * @param {string} key
 * @param {number} [windowMs=RATE_LIMIT_WINDOW_MS]
 */
const recordDemoAccessFailure = (key, windowMs = RATE_LIMIT_WINDOW_MS) => {
  if (!key) return;
  const now = Date.now();
  const record = failedAttemptsMap.get(key);

  if (!record || (now - record.firstAttemptAt > windowMs)) {
    failedAttemptsMap.set(key, { count: 1, firstAttemptAt: now, lastAttemptAt: now });
  } else {
    record.count += 1;
    record.lastAttemptAt = now;
  }
};

/**
 * Clears failed attempts for a key upon successful authentication.
 * @param {string} key
 */
const clearDemoAccessFailures = (key) => {
  if (key) failedAttemptsMap.delete(key);
};

/**
 * Resets all rate limits (for testing and isolation).
 */
const resetAllDemoRateLimits = () => {
  failedAttemptsMap.clear();
};

module.exports = {
  isDemoPaymentPermitted,
  isDemoAccessCodeRequired,
  verifyDemoAccessCode,
  isDemoAccessRateLimited,
  recordDemoAccessFailure,
  clearDemoAccessFailures,
  resetAllDemoRateLimits,
  MAX_FAILED_ATTEMPTS,
  RATE_LIMIT_WINDOW_MS,
  STAGING_SERVICE_ID,
  STAGING_SERVICE_NAME,
  STAGING_GIT_BRANCH
};
