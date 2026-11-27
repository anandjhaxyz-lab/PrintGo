const logger = require('../utils/logger');
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

const STAGING_PRINTER_APPROVAL_PATTERN = /^\/api\/admin\/printer-discoveries\/[a-zA-Z0-9_-]+\/approve$/;
// One-device emergency staging exception. Immutable ID read from staging DB.
const STAGING_CANON_DISABLE_DEVICE_ID = '114c0092-e3c6-4432-b17f-e7c6f42ec334';
const STAGING_CANON_DISABLE_GIT_BRANCH = 'fix/staging-canon-disable-minimal';
const STAGING_CANON_DISABLE_PATH = '/api/admin/printer-devices/' + STAGING_CANON_DISABLE_DEVICE_ID + '/disable';

const isAllowedStagingCanonDisable = (req) => {
  if (process.env.APP_ENV !== 'staging') return false;
  if (process.env.RENDER !== 'true') return false;
  if (process.env.RENDER_SERVICE_ID !== STAGING_SERVICE_ID) return false;
  if (process.env.RENDER_SERVICE_NAME !== STAGING_SERVICE_NAME) return false;
  if (process.env.RENDER_GIT_BRANCH !== STAGING_CANON_DISABLE_GIT_BRANCH) return false;
  if (process.env.STAGING_CANON_DISABLE_ENABLED !== 'true') return false;
  if ((req.method || '').toUpperCase() !== 'POST') return false;
  if (getCleanPath(req) !== STAGING_CANON_DISABLE_PATH) return false;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 10 || reason.length > 500) return false;
  logger?.warn?.('[READ_ONLY_GUARD] Authorized exact Canon staging disable exception; service layer enforces role, lease lock and audit log.');
  return true;
};

// Exact staging-only device QR creation exception. Global ADMIN_READ_ONLY stays enabled.
const STAGING_DEVICE_QR_CREATION_GIT_BRANCH = 'fix/staging-agent-handshake-compat';
const STAGING_PRINTER_QR_DEVICES = Object.freeze({
  '114c0092-e3c6-4432-b17f-e7c6f42ec334': 'Canon Generic Plus UFR II (Copy 2)',
  '619665e1-3c64-44eb-8f57-cb8c3c895e9b': 'EPSON L6460 Series',
  '77554510-b102-40c7-957f-6f735eba0bdc': 'HP LaserJet Professional M1136 MFP (Copy 1)'
});

const isAllowedStagingDeviceQrCreation = (req) => {
  if (process.env.APP_ENV !== 'staging') return false;
  if (process.env.RENDER !== 'true') return false;
  if (process.env.RENDER_SERVICE_ID !== STAGING_SERVICE_ID) return false;
  if (process.env.RENDER_SERVICE_NAME !== STAGING_SERVICE_NAME) return false;
  if (process.env.RENDER_GIT_BRANCH !== STAGING_DEVICE_QR_CREATION_GIT_BRANCH) return false;
  if (process.env.STAGING_DEVICE_QR_CREATION_ENABLED !== 'true') return false;
  if ((req.method || '').toUpperCase() !== 'POST') return false;

  const cleanPath = getCleanPath(req);
  const match = cleanPath.match(/^\/api\/admin\/printer-devices\/([0-9a-f-]{36})\/qr$/i);
  if (!match) return false;

  const expectedLabel = STAGING_PRINTER_QR_DEVICES[match[1].toLowerCase()];
  if (!expectedLabel) return false;

  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (Object.keys(body).length !== 1 || !Object.prototype.hasOwnProperty.call(body, 'label')) return false;
  if (body.label !== expectedLabel) return false;

  logger?.warn?.(`[READ_ONLY_GUARD] Authorized exact staging device QR creation exception for device ${match[1]}.`);
  return true;
};
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

/**
 * Dedicated, narrowly scoped, fail-closed Staging-only permission for printer discovery approval.
 * Permits ONLY POST /api/admin/printer-discoveries/:id/approve with body containing { isDefault: false }
 * on the exact authorized Staging Render service instance.
 *
 * Fails closed unless ALL conditions are strictly satisfied:
 * 1. APP_ENV is exactly 'staging'
 * 2. RENDER is exactly 'true'
 * 3. RENDER_SERVICE_ID matches 'srv-dbqpapon74is73csbc80'
 * 4. RENDER_SERVICE_NAME matches 'printgo-backend-staging'
 * 5. RENDER_GIT_BRANCH matches 'feature/printgo-production-readiness'
 * 6. STAGING_PRINTER_APPROVALS_ENABLED === 'true' (or ALLOW_STAGING_PRINTER_APPROVALS === 'true')
 * 7. HTTP method is strictly POST
 * 8. Normalized API path exactly matches /api/admin/printer-discoveries/{id}/approve
 * 9. req.body is an object and req.body.isDefault is strictly boolean false (=== false)
 *
 * @param {Object} req - Express request object
 * @returns {boolean}
 */
const isAllowedStagingPrinterApproval = (req) => {
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

  // 6. Dedicated staging flag enabled (STAGING_PRINTER_APPROVALS_ENABLED or ALLOW_STAGING_PRINTER_APPROVALS)
  const isEnabled = process.env.STAGING_PRINTER_APPROVALS_ENABLED === 'true' ||
                    process.env.ALLOW_STAGING_PRINTER_APPROVALS === 'true';
  if (!isEnabled) return false;

  // 7. HTTP method is strictly POST
  const method = (req.method || '').toUpperCase();
  if (method !== 'POST') return false;

  // 8. Normalized API path matches /api/admin/printer-discoveries/:id/approve
  const cleanPath = getCleanPath(req);
  if (!STAGING_PRINTER_APPROVAL_PATTERN.test(cleanPath)) return false;

  // 9. req.body must explicitly specify isDefault: false (strictly boolean false)
  if (!req.body || typeof req.body !== 'object' || req.body.isDefault !== false) {
    logger?.warn?.(`[READ_ONLY_GUARD] Rejected staging printer approval for ${cleanPath}: isDefault must be strictly false`);
    return false;
  }

  logger?.info?.(`[READ_ONLY_GUARD] Authorized staging printer discovery approval exemption for ${cleanPath}`);
  return true;
};

const STAGING_LEGACY_QR_BINDING_GIT_BRANCH = STAGING_GIT_BRANCH;
const LEGACY_QR_BINDING_APPROVAL_PATH = /^\/api\/admin\/printer-qrs\/[a-zA-Z0-9_-]+\/legacy-binding$/;
const LEGACY_QR_BINDING_REVOCATION_PATH = /^\/api\/admin\/printer-qrs\/[a-zA-Z0-9_-]+\/legacy-binding\/revoke$/;

const isAllowedStagingLegacyQrBindingMutation = (req) => {
  if (process.env.APP_ENV !== 'staging' || process.env.RENDER !== 'true') return false;
  if (process.env.RENDER_SERVICE_ID !== STAGING_SERVICE_ID || process.env.RENDER_SERVICE_NAME !== STAGING_SERVICE_NAME) return false;
  if (process.env.RENDER_GIT_BRANCH !== STAGING_LEGACY_QR_BINDING_GIT_BRANCH) return false;
  if (process.env.STAGING_LEGACY_QR_BINDINGS_ENABLED !== 'true') return false;
  if ((req.method || '').toUpperCase() !== 'POST') return false;
  const path = getCleanPath(req);
  const approval = LEGACY_QR_BINDING_APPROVAL_PATH.test(path);
  const revocation = LEGACY_QR_BINDING_REVOCATION_PATH.test(path);
  if (!approval && !revocation) return false;
  if (req.user?.role !== 'SUPERADMIN') return false;
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort();
  const expected = approval ? ['printerDeviceId', 'reason'] : ['reason'];
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) return false;
  if (typeof body.reason !== 'string' || body.reason.replace(/\s/g, '').length < 10 || body.reason.trim().length > 500) return false;
  if (approval && (typeof body.printerDeviceId !== 'string' || !body.printerDeviceId.trim())) return false;
  logger?.warn?.('[READ_ONLY_GUARD] Authorized exact staging legacy printer QR binding mutation.');
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

      if (isAllowedStagingPrinterApproval(req)) {
        return next();
      }

      if (isAllowedStagingCanonDisable(req)) {
        return next();
      }

      if (isAllowedStagingDeviceQrCreation(req)) {
        return next();
      }

      if (isAllowedStagingLegacyQrBindingMutation(req)) {
        return next();
      }

      const cleanPath = getCleanPath(req);
      logger?.warn?.(`[READ_ONLY_GUARD] Blocked mutation: ${req.method} ${cleanPath} (ADMIN_READ_ONLY=true)`);

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
  isAllowedStagingPrinterApproval,
  isAllowedStagingCanonDisable,
  isAllowedStagingDeviceQrCreation,
  isAllowedStagingLegacyQrBindingMutation,
  STAGING_LEGACY_QR_BINDING_GIT_BRANCH,
  STAGING_DEVICE_QR_CREATION_GIT_BRANCH,
  STAGING_PRINTER_QR_DEVICES,
  STAGING_CANON_DISABLE_DEVICE_ID,
  STAGING_CANON_DISABLE_GIT_BRANCH,
  getCleanPath,
  ALLOWED_AD_MUTATION_PATTERNS,
  ALLOWED_CASH_MUTATION_PATTERNS,
  STAGING_PRINTER_APPROVAL_PATTERN
};
