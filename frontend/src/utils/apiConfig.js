/**
 * Centralized API & Socket Origin Resolver
 * Ensures split-origin deployments (e.g. HTTPS frontend on Vercel + HTTPS backend on Render/custom domain)
 * always preserve explicit VITE_API_URL rather than stripping it on https://.
 */

const normalizeBaseUrl = (raw) => {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().replace(/\/+$/, '');
};

/**
 * Returns the backend API base URL for REST and Socket.IO calls.
 * Accepts optional overrides for deterministic unit testing.
 */
export const getApiUrl = ({ envApiUrl, locationObj } = {}) => {
  const configured = normalizeBaseUrl(
    envApiUrl !== undefined ? envApiUrl : import.meta?.env?.VITE_API_URL
  );
  if (configured) {
    return configured;
  }

  const loc = locationObj !== undefined
    ? locationObj
    : (typeof window !== 'undefined' ? window.location : null);

  if (loc) {
    const port = String(loc.port || '');
    const isLocalDevPort = ['5173', '4173', '3000'].includes(port);
    if (isLocalDevPort && loc.hostname) {
      return `${loc.protocol || 'http:'}//${loc.hostname}:5000`;
    }
    return '';
  }

  return 'http://localhost:5000';
};

/**
 * Checks whether the frontend origin and configured backend API origin are safe and valid.
 * Never reads or returns secret keys.
 */
export const validateOriginConfig = ({ envApiUrl, locationObj } = {}) => {
  const apiUrl = getApiUrl({ envApiUrl, locationObj });
  const loc = locationObj !== undefined
    ? locationObj
    : (typeof window !== 'undefined' ? window.location : null);

  const isHttpsFrontend = Boolean(loc && loc.protocol === 'https:');
  const warnings = [];

  if (isHttpsFrontend && apiUrl && apiUrl.startsWith('http://')) {
    warnings.push('HTTPS frontend is configured with an insecure HTTP API URL.');
  }

  return {
    apiUrl,
    isSplitOrigin: Boolean(apiUrl && loc && !apiUrl.startsWith(loc.origin || '')),
    isHttpsFrontend,
    warnings,
  };
};
