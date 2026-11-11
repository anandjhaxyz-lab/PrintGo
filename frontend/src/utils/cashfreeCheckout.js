import { load as loadCashfreeSdk } from '@cashfreepayments/cashfree-js';

/**
 * Normalizes backend environment strings ('SANDBOX', 'sandbox', 'PRODUCTION', etc.)
 * into @cashfreepayments/cashfree-js v3 SDK modes ('sandbox' | 'production').
 */
export const normalizeCashfreeMode = (envValue) => {
  const normalized = String(envValue || '').trim().toLowerCase();
  return normalized === 'production' || normalized === 'prod' ? 'production' : 'sandbox';
};

/**
 * Launches Cashfree v3 Drop-in / Modal or Redirect Checkout for a backend-created paymentSessionId.
 * Supports dependency injection (sdkLoader) for isolated unit testing.
 * Never triggers print dispatch directly — callers must verify via GET /api/payments/verify/:id.
 */
export const launchCashfreeCheckout = async ({
  paymentSessionId,
  orderId,
  environment = 'sandbox',
  returnUrl,
  redirectTarget = '_modal',
  sdkLoader = loadCashfreeSdk,
} = {}) => {
  if (!paymentSessionId) {
    throw new Error('Missing Cashfree paymentSessionId from server order creation.');
  }

  const mode = normalizeCashfreeMode(environment);
  const cashfree = await sdkLoader({ mode });

  if (!cashfree || typeof cashfree.checkout !== 'function') {
    throw new Error('Cashfree Checkout SDK failed to initialize. Please retry.');
  }

  const checkoutOptions = {
    paymentSessionId,
    redirectTarget,
  };
  if (returnUrl) {
    checkoutOptions.returnUrl = returnUrl;
  }

  const result = await cashfree.checkout(checkoutOptions);

  if (result?.error) {
    return {
      outcome: 'FAILED_OR_CANCELLED',
      mode,
      orderId,
      message: result.error.message || 'Payment was cancelled or failed at Cashfree.',
      error: result.error,
      result,
    };
  }

  if (result?.redirect) {
    return {
      outcome: 'REDIRECTED',
      mode,
      orderId,
      result,
    };
  }

  if (result?.paymentDetails) {
    return {
      outcome: 'MODAL_COMPLETED',
      mode,
      orderId,
      paymentDetails: result.paymentDetails,
      result,
    };
  }

  return {
    outcome: 'DISMISSED_OR_UNKNOWN',
    mode,
    orderId,
    result,
  };
};
