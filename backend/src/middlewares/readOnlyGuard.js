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
  getCleanPath,
  ALLOWED_AD_MUTATION_PATTERNS,
  ALLOWED_CASH_MUTATION_PATTERNS
};
