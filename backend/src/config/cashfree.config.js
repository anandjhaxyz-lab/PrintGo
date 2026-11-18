/**
 * Cashfree Gateway Configuration & Validation
 * Official Cashfree PG API Version: 2023-08-01
 */

const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const KNOWN_PLACEHOLDERS = [
  'TEST_APP_ID',
  'TEST_SECRET_KEY',
  'YOUR_APP_ID',
  'YOUR_SECRET_KEY',
  'YOUR_SANDBOX_APP_ID',
  'YOUR_SANDBOX_SECRET_KEY',
  'PLACEHOLDER',
  'DUMMY'
];

/**
 * Resolves the normalized Cashfree target environment ('sandbox' | 'production').
 * Standardizes on CASHFREE_ENV while supporting legacy CASHFREE_ENVIRONMENT alias safely.
 */
const resolveCashfreeEnv = () => {
  const rawPrimary = process.env.CASHFREE_ENV?.trim();
  const rawAlias = process.env.CASHFREE_ENVIRONMENT?.trim();

  const normalize = (val) => {
    if (!val) return null;
    const lower = val.toLowerCase();
    if (lower === 'sandbox' || lower === 'test') return 'sandbox';
    if (lower === 'production' || lower === 'prod') return 'production';
    return 'INVALID';
  };

  const primary = normalize(rawPrimary);
  const alias = normalize(rawAlias);

  if (primary === 'INVALID') {
    return { env: null, error: `Invalid CASHFREE_ENV value '${rawPrimary}'. Must be 'sandbox' or 'production'.` };
  }
  if (alias === 'INVALID') {
    return { env: null, error: `Invalid CASHFREE_ENVIRONMENT value '${rawAlias}'. Must be 'sandbox'/'TEST' or 'production'/'PROD'.` };
  }
  if (primary && alias && primary !== alias) {
    return { env: null, error: `Conflicting Cashfree env configuration: CASHFREE_ENV='${rawPrimary}' vs CASHFREE_ENVIRONMENT='${rawAlias}'.` };
  }

  return { env: primary || alias || 'sandbox', error: null };
};

/**
 * Returns valid public app base URL if configured cleanly.
 */
const getPublicAppUrl = () => {
  const candidate = (
    process.env.PUBLIC_APP_URL ||
    process.env.PUBLIC_FRONTEND_URL ||
    process.env.FRONTEND_URL ||
    ''
  ).trim().replace(/\/+$/, '');
  return candidate || null;
};

/**
 * Computes strictly allowed origins for client-supplied payment return URLs.
 */
const getAllowedReturnOrigins = () => {
  const origins = new Set();
  const envVars = [
    process.env.PUBLIC_APP_URL,
    process.env.PUBLIC_FRONTEND_URL,
    process.env.FRONTEND_URL,
    process.env.ALLOWED_ORIGINS
  ];

  for (const raw of envVars) {
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        origins.add(new URL(trimmed).origin);
      } catch {
        // Ignore malformed URL entries in env
      }
    }
  }

  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
    origins.add('http://localhost:3000');
    origins.add('http://127.0.0.1:3000');
    origins.add('http://localhost:5000');
    origins.add('http://127.0.0.1:5000');
  }

  return origins;
};

/**
 * Validates client-supplied returnUrl against whitelisted frontend origins.
 * Returns normalized string (without percent-encoding {order_id}) or null if omitted.
 */
const validateReturnUrl = (clientReturnUrl) => {
  if (!clientReturnUrl) return null;
  if (typeof clientReturnUrl !== 'string') {
    throw new AppError('Invalid returnUrl format', 400);
  }

  const trimmed = clientReturnUrl.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError('Invalid returnUrl: malformed URL', 400);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('Invalid returnUrl: only http/https protocols are allowed', 400);
  }

  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new AppError('Invalid returnUrl: HTTPS is required in production', 400);
  }

  const allowedOrigins = getAllowedReturnOrigins();
  if (!allowedOrigins.has(parsed.origin)) {
    logger.warn(`Rejected untrusted returnUrl origin: ${parsed.origin}`);
    throw new AppError('Invalid returnUrl: origin is not permitted', 400);
  }

  return trimmed;
};

/**
 * Resolves and validates webhook notify_url if configured.
 */
const resolveNotifyUrl = () => {
  const explicit = process.env.CASHFREE_NOTIFY_URL?.trim();
  const publicBase = getPublicAppUrl();
  const candidate = explicit || (publicBase ? `${publicBase}/api/payments/webhook` : '');
  if (!candidate) return undefined;

  try {
    const parsed = new URL(candidate);
    if (process.env.NODE_ENV === 'production') {
      const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      if (parsed.protocol !== 'https:' || isLocal) {
        logger.warn(`Ignoring unsafe production notify_url: ${candidate}`);
        return undefined;
      }
    }
    return candidate;
  } catch {
    logger.warn(`Ignoring invalid CASHFREE_NOTIFY_URL: ${candidate}`);
    return undefined;
  }
};

/**
 * Validates whether the configured credentials are valid non-placeholder strings
 * and strictly consistent with the configured Cashfree environment.
 */
const validateCashfreeConfig = () => {
  const appId = process.env.CASHFREE_APP_ID?.trim();
  const secretKey = process.env.CASHFREE_SECRET_KEY?.trim();

  const missing = [];
  if (!appId) missing.push('CASHFREE_APP_ID');
  if (!secretKey) missing.push('CASHFREE_SECRET_KEY');

  if (missing.length > 0) {
    return {
      isValid: false,
      isConfigured: false,
      reason: `Missing required environment variables: ${missing.join(', ')}`,
      environment: 'UNCONFIGURED',
      isProduction: false
    };
  }

  const isPlaceholder = KNOWN_PLACEHOLDERS.some(
    p => appId.toUpperCase().includes(p) || secretKey.toUpperCase().includes(p)
  );

  if (isPlaceholder) {
    return {
      isValid: false,
      isConfigured: true,
      reason: 'CASHFREE credentials contain placeholder/test mock strings. Live sandbox/production calls are disabled.',
      environment: 'MOCK_PLACEHOLDER',
      isProduction: false
    };
  }

  const { env, error } = resolveCashfreeEnv();
  if (error) {
    return {
      isValid: false,
      isConfigured: true,
      reason: error,
      environment: 'INVALID_ENV',
      isProduction: false
    };
  }

  const isProd = env === 'production';
  const looksLikeTestKey =
    appId.toUpperCase().startsWith('TEST') ||
    secretKey.toLowerCase().startsWith('cfsk_ma_test_');
  const looksLikeProdKey =
    secretKey.toLowerCase().startsWith('cfsk_ma_prod_');

  if (isProd && looksLikeTestKey) {
    return {
      isValid: false,
      isConfigured: true,
      reason: 'Environment mismatch: Sandbox/Test Cashfree credentials cannot be used when CASHFREE_ENV=production.',
      environment: 'ENV_MISMATCH',
      isProduction: true
    };
  }

  if (!isProd && looksLikeProdKey) {
    return {
      isValid: false,
      isConfigured: true,
      reason: 'Environment mismatch: Production Cashfree secret key cannot be used when CASHFREE_ENV=sandbox.',
      environment: 'ENV_MISMATCH',
      isProduction: false
    };
  }

  return {
    isValid: true,
    isConfigured: true,
    environment: isProd ? 'PRODUCTION' : 'SANDBOX',
    isProduction: isProd
  };
};

/**
 * Checks whether merchant KYC approval and gateway readiness have been explicitly verified.
 * Syntactic credentials alone do not imply active gateway settlement status.
 */
const isCashfreeKycApproved = () => {
  return process.env.CASHFREE_KYC_VERIFIED === 'true' || process.env.CASHFREE_MERCHANT_KYC_APPROVED === 'true';
};

/**
 * Returns Cashfree HTTP headers and base URL.
 */
const getCashfreeConfig = () => {
  const validation = validateCashfreeConfig();

  const baseUrl = validation.isProduction
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';

  return {
    baseUrl,
    orderUrl: `${baseUrl}/orders`,
    notifyUrl: resolveNotifyUrl(),
    publicAppUrl: getPublicAppUrl(),
    headers: {
      'x-client-id': process.env.CASHFREE_APP_ID || '',
      'x-client-secret': process.env.CASHFREE_SECRET_KEY || '',
      'x-api-version': '2023-08-01',
      'Content-Type': 'application/json'
    },
    timeout: 10000, // 10 second HTTP timeout
    validation
  };
};

/**
 * Redacts secrets and sensitive details from payloads before writing to logs or DB.
 */
const redactSensitiveData = (data) => {
  if (!data) return null;
  if (typeof data !== 'object') {
    try {
      data = JSON.parse(data);
    } catch {
      return String(data);
    }
  }

  const copy = JSON.parse(JSON.stringify(data));
  const sensitiveKeys = ['x-client-secret', 'client_secret', 'secret', 'password', 'token', 'key', 'card_number', 'cvv'];

  const redactRecursive = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (sensitiveKeys.some(s => k.toLowerCase().includes(s))) {
        obj[k] = '***REDACTED***';
      } else if (typeof obj[k] === 'object') {
        redactRecursive(obj[k]);
      }
    }
  };

  redactRecursive(copy);
  return JSON.stringify(copy);
};

module.exports = {
  resolveCashfreeEnv,
  validateCashfreeConfig,
  isCashfreeKycApproved,
  getCashfreeConfig,
  getPublicAppUrl,
  getAllowedReturnOrigins,
  validateReturnUrl,
  resolveNotifyUrl,
  redactSensitiveData,
  API_VERSION: '2023-08-01'
};
