const {
  STAGING_SERVICE_ID,
  STAGING_SERVICE_NAME,
  STAGING_GIT_BRANCH
} = require('../utils/demoPaymentGuard');

const ALLOWED_AD_MUTATION_PATTERNS = [
  { method: 'POST', regex: /^\/api\/advertisements\/admin$/ },
  { method: 'PUT', regex: /^\/api\/advertisements\/admin\/[^/]+$/ },
  { method: 'PATCH', regex: /^\/api\/advertisements\/admin\/reorder$/ },
  { method: 'PATCH', regex: /^\/api\/advertisements\/admin\/[^/]+\/toggle$/ },
  { method: 'DELETE', regex: /^\/api\/advertisements\/admin\/[^/]+$/ },
  { method: 'POST', regex: /^\/api\/machines\/[^/]+\/ad-suppression$/ },
  { method: 'DELETE', regex: /^\/api\/machines\/[^/]+\/ad-suppression$/ }
];

const ALLOWED_CASH_MUTATION_PATTERNS = [
  { method: 'PUT', regex: /^\/api\/machines\/[^/]+\/payment-mode$/ },
  { method: 'POST', regex: /^\/api\/admin\/jobs\/[^/]+\/confirm-cash$/ }
];

const getCleanPath = (req) => {
  let target = '';
  if (req.baseUrl && req.path) {
    target = `${req.baseUrl}${req.path}`;
  } else if (req.originalUrl) {
    target = req.originalUrl;
  } else if (req.path) {
    target = req.path;
  } else if (req.url) {
    target = req.url;
  }

  const withoutQuery = target.split('?')[0].split('#')[0];
  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch (e) {
    // Malformed URI encoded string, keep raw
  }

  // Normalize duplicate slashes and strip trailing slash (except root)
  const normalized = decoded.replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
};

const isAllowedAdMutation = (req) => {
  if (process.env.ALLOW_ADVERTISEMENT_MUTATIONS !== 'true') {
    return false;
  }

  const method = (req.method || '').toUpperCase();
  const cleanPath = getCleanPath(req);

  return ALLOWED_AD_MUTATION_PATTERNS.some(
    (pattern) => pattern.method === method && pattern.regex.test(cleanPath)
  );
};

const isAllowedCashMutation = (req) => {
  if (process.env.APP_ENV !== 'staging' || process.env.ALLOW_CASH_PAYMENT_MUTATIONS !== 'true') {
    return false;
  }

  const method = (req.method || '').toUpperCase();
  const cleanPath = getCleanPath(req);

  return ALLOWED_CASH_MUTATION_PATTERNS.some(
    (pattern) => pattern.method === method && pattern.regex.test(cleanPath)
  );
};

/**
 * Dedicated, narrowly scoped, fail-closed Staging-only permission for payment-mode configuration.
 * Permits ONLY PUT /api/machines/:allowedMachineId/payment-mode with body { paymentMode: 'DEMO_SIMULATION' }
 * on the exact authorized Staging Render service instance.
 *
 * Fails closed unless ALL 10 conditions are strictly satisfied:
 * 1. APP_ENV is exactly 'staging'
 * 2. RENDER is exactly 'true'
 * 3. RENDER_SERVICE_ID matches 'srv-dbqpapon74is73csbc80'
 * 4. RENDER_SERVICE_NAME matches 'printgo-backend-staging'
 * 5. RENDER_GIT_BRANCH matches 'feature/printgo-production-readiness'
 * 6. ALLOW_STAGING_PAYMENT_MODE_CONFIG is exactly 'true'
 * 7. Requested machine ID exactly matches STAGING_PAYMENT_MODE_ALLOWED_MACHINE_ID
 * 8. HTTP method is PUT
 * 9. Normalized API path is exactly /api/machines/{allowedMachineId}/payment-mode
 * 10. Requested paymentMode in request body is exactly 'DEMO_SIMULATION'
 *
 * @param {Object} req - Express request object
 * @returns {boolean}
 */
const isAllowedStagingPaymentModeConfig = (req) => {
  // 1. APP_ENV is exactly staging
  if (process.env.APP_ENV !== 'staging') return false;

  // 2. RENDER is exactly true
  if (process.env.RENDER !== 'true') return false;

  // 3. RENDER_SERVICE_ID matches srv-dbqpapon74is73csbc80
  if (process.env.RENDER_SERVICE_ID !== STAGING_SERVICE_ID) return false;

  // 4. RENDER_SERVICE_NAME matches printgo-backend-staging
  if (process.env.RENDER_SERVICE_NAME !== STAGING_SERVICE_NAME) return false;

  // 5. RENDER_GIT_BRANCH matches feature/printgo-production-readiness
  if (process.env.RENDER_GIT_BRANCH !== STAGING_GIT_BRANCH) return false;

  // 6. ALLOW_STAGING_PAYMENT_MODE_CONFIG is exactly true
  if (process.env.ALLOW_STAGING_PAYMENT_MODE_CONFIG !== 'true') return false;

  // 7. Configured allowed machine ID must be non-empty
  const allowedMachineId = (process.env.STAGING_PAYMENT_MODE_ALLOWED_MACHINE_ID || '').trim();
  if (!allowedMachineId) return false;

  // 8. HTTP method is PUT
  const method = (req.method || '').toUpperCase();
  if (method !== 'PUT') return false;

  // 9. Normalized API path is exactly /api/machines/{allowedMachineId}/payment-mode
  const cleanPath = getCleanPath(req);
  if (cleanPath !== `/api/machines/${allowedMachineId}/payment-mode`) return false;

  // 10. Requested paymentMode is exactly DEMO_SIMULATION
  const paymentMode = req.body?.paymentMode;
  if (paymentMode !== 'DEMO_SIMULATION') return false;

  return true;
};

const readOnlyGuard = (req, res, next) => {
  if (process.env.ADMIN_READ_ONLY === 'true') {
    const mutationMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
    if (mutationMethods.includes((req.method || '').toUpperCase())) {
      if (isAllowedAdMutation(req)) {
        return next();
      }

      if (isAllowedCashMutation(req)) {
        return next();
      }

      if (isAllowedStagingPaymentModeConfig(req)) {
        return next();
      }

      return res.status(403).json({
        success: false,
        error: 'Forbidden: Cloud Admin Dashboard is operating in Read-Only Monitoring Mode. Remote mutations are disabled.'
      });
    }
  }
  next();
};

module.exports = {
  readOnlyGuard,
  isAllowedAdMutation,
  isAllowedCashMutation,
  isAllowedStagingPaymentModeConfig,
  getCleanPath,
  ALLOWED_AD_MUTATION_PATTERNS,
  ALLOWED_CASH_MUTATION_PATTERNS
};
