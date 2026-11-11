/**
 * Customer Checkout & Session Recovery Helper
 * Persists only non-secret session/order recovery metadata across Cashfree redirects,
 * page refreshes, and browser Back navigation within the same browser tab.
 */

const STORAGE_PREFIX = 'printgo_pilot_session_';
const ACTIVE_SCOPE_KEY = 'printgo_pilot_active_scope';

const getStorage = () => {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // Ignore storage access errors in restricted frames
  }
  return null;
};

export const buildSessionScopeKey = ({ publicCode, sessionId } = {}) => {
  if (publicCode) return `qr:${publicCode}`;
  if (sessionId) return `sid:${sessionId}`;
  return 'default';
};

export const isSessionStillValid = (expiresAt, nowMs = Date.now()) => {
  if (!expiresAt) return true;
  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs)) return false;
  return expiryMs - nowMs > 10 * 1000;
};

export const loadRecoveredSession = ({ publicCode, sessionId } = {}) => {
  const store = getStorage();
  if (!store) return null;

  const scopeKey = buildSessionScopeKey({ publicCode, sessionId });
  try {
    const raw = store.getItem(`${STORAGE_PREFIX}${scopeKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.sessionToken || !parsed.sessionCode) return null;
    if (!isSessionStillValid(parsed.expiresAt)) {
      store.removeItem(`${STORAGE_PREFIX}${scopeKey}`);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

export const saveRecoveredSession = ({ publicCode, sessionId }, data = {}) => {
  const store = getStorage();
  if (!store) return;

  const scopeKey = buildSessionScopeKey({ publicCode, sessionId });
  try {
    const existing = loadRecoveredSession({ publicCode, sessionId }) || {};
    const merged = {
      ...existing,
      ...data,
      scopeKey,
      updatedAt: new Date().toISOString(),
    };
    store.setItem(`${STORAGE_PREFIX}${scopeKey}`, JSON.stringify(merged));
    store.setItem(ACTIVE_SCOPE_KEY, scopeKey);
  } catch {
    // Ignore quota or serialization issues
  }
};

export const clearRecoveredJob = ({ publicCode, sessionId } = {}) => {
  const store = getStorage();
  if (!store) return;

  const existing = loadRecoveredSession({ publicCode, sessionId });
  if (!existing) return;

  const next = { ...existing };
  delete next.jobId;
  delete next.orderId;
  delete next.paymentState;
  delete next.price;
  delete next.pricingBreakdown;
  saveRecoveredSession({ publicCode, sessionId }, next);
};

export const clearRecoveredSession = ({ publicCode, sessionId } = {}) => {
  const store = getStorage();
  if (!store) return;
  const scopeKey = buildSessionScopeKey({ publicCode, sessionId });
  try {
    store.removeItem(`${STORAGE_PREFIX}${scopeKey}`);
  } catch {
    // Ignore storage removal errors
  }
};
