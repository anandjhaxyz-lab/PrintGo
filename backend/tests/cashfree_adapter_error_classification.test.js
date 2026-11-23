const axios = require('axios');
const cashfreeGateway = require('../src/services/cashfreeGateway.adapter');

jest.mock('axios');
jest.mock('../src/config/cashfree.config', () => ({
  getCashfreeConfig: jest.fn(() => ({
    orderUrl: 'https://sandbox.cashfree.com/pg/orders',
    timeout: 10000,
    headers: { 'x-client-id': 'test', 'x-client-secret': 'test' },
    validation: { isValid: true }
  })),
  validateCashfreeConfig: jest.fn(() => ({ isValid: true })),
  redactSensitiveData: jest.fn(data => data)
}));

describe('Cashfree Gateway Adapter Error Classification', () => {
  const orderId = 'order_test_err_001';
  const refundId = 'ref_test_err_001';
  const amount = 50.0;

  beforeEach(() => {
    jest.clearAllMocks();
    cashfreeGateway.setMockMode(false);
  });

  test('HTTP 400 is classified as definitive failure and FAILED status', async () => {
    const error400 = new Error('Request failed with status code 400');
    error400.response = {
      status: 400,
      data: { message: 'order_status_invalid: Order is not eligible for refund' }
    };
    axios.post.mockRejectedValueOnce(error400);

    const result = await cashfreeGateway.createRefund({ orderId, refundId, amount });

    expect(result.success).toBe(false);
    expect(result.isDefinitiveFailure).toBe(true);
    expect(result.isUncertainOutcome).toBe(false);
    expect(result.isTimeout).toBe(false);
    expect(result.isRateLimited).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(result.statusCode).toBe(400);
  });

  test('HTTP 408 is classified as timeout and uncertain outcome with PROCESSING status', async () => {
    const error408 = new Error('Request failed with status code 408');
    error408.response = {
      status: 408,
      data: { message: 'Request Timeout' }
    };
    axios.post.mockRejectedValueOnce(error408);

    const result = await cashfreeGateway.createRefund({ orderId, refundId, amount });

    expect(result.success).toBe(false);
    expect(result.isTimeout).toBe(true);
    expect(result.isUncertainOutcome).toBe(true);
    expect(result.isDefinitiveFailure).toBe(false);
    expect(result.isRateLimited).toBe(false);
    expect(result.status).toBe('PROCESSING');
    expect(result.statusCode).toBe(408);
  });

  test('HTTP 429 is classified as rate-limited and uncertain outcome with PROCESSING status', async () => {
    const error429 = new Error('Request failed with status code 429');
    error429.response = {
      status: 429,
      data: { message: 'Too Many Requests: Rate limit exceeded' }
    };
    axios.post.mockRejectedValueOnce(error429);

    const result = await cashfreeGateway.createRefund({ orderId, refundId, amount });

    expect(result.success).toBe(false);
    expect(result.isRateLimited).toBe(true);
    expect(result.isUncertainOutcome).toBe(true);
    expect(result.isDefinitiveFailure).toBe(false);
    expect(result.status).toBe('PROCESSING');
    expect(result.statusCode).toBe(429);
  });

  test('HTTP 409 duplicate refund is classified as duplicate with PROCESSING status', async () => {
    const error409 = new Error('Request failed with status code 409');
    error409.response = {
      status: 409,
      data: { code: 'refund_already_exists', message: 'Refund already exists for order' }
    };
    axios.post.mockRejectedValueOnce(error409);

    const result = await cashfreeGateway.createRefund({ orderId, refundId, amount });

    expect(result.success).toBe(false);
    expect(result.isDuplicate).toBe(true);
    expect(result.isDefinitiveFailure).toBe(false);
    expect(result.status).toBe('PROCESSING');
    expect(result.statusCode).toBe(409);
  });

  test('HTTP 502 / 503 is classified as server error and uncertain outcome with PROCESSING status', async () => {
    const error503 = new Error('Request failed with status code 503');
    error503.response = {
      status: 503,
      data: { message: 'Service Unavailable' }
    };
    axios.post.mockRejectedValueOnce(error503);

    const result = await cashfreeGateway.createRefund({ orderId, refundId, amount });

    expect(result.success).toBe(false);
    expect(result.isServerError).toBe(true);
    expect(result.isUncertainOutcome).toBe(true);
    expect(result.isDefinitiveFailure).toBe(false);
    expect(result.status).toBe('PROCESSING');
    expect(result.statusCode).toBe(503);
  });

  test('ECONNRESET is classified as connection reset and uncertain outcome with PROCESSING status', async () => {
    const errorReset = new Error('read ECONNRESET');
    errorReset.code = 'ECONNRESET';
    axios.post.mockRejectedValueOnce(errorReset);

    const result = await cashfreeGateway.createRefund({ orderId, refundId, amount });

    expect(result.success).toBe(false);
    expect(result.isConnectionReset).toBe(true);
    expect(result.isUncertainOutcome).toBe(true);
    expect(result.isDefinitiveFailure).toBe(false);
    expect(result.status).toBe('PROCESSING');
  });

  test('ECONNABORTED client timeout is classified as timeout and uncertain outcome with PROCESSING status', async () => {
    const errorAbort = new Error('timeout of 10000ms exceeded');
    errorAbort.code = 'ECONNABORTED';
    axios.post.mockRejectedValueOnce(errorAbort);

    const result = await cashfreeGateway.createRefund({ orderId, refundId, amount });

    expect(result.success).toBe(false);
    expect(result.isTimeout).toBe(true);
    expect(result.isUncertainOutcome).toBe(true);
    expect(result.isDefinitiveFailure).toBe(false);
    expect(result.status).toBe('PROCESSING');
    expect(result.statusCode).toBe(408);
  });

  test('Unclassified / network failure without response is classified as uncertain outcome with PROCESSING status', async () => {
    const errorUnknown = new Error('DNS resolution failed or unknown network error');
    axios.post.mockRejectedValueOnce(errorUnknown);

    const result = await cashfreeGateway.createRefund({ orderId, refundId, amount });

    expect(result.success).toBe(false);
    expect(result.isUncertainOutcome).toBe(true);
    expect(result.isDefinitiveFailure).toBe(false);
    expect(result.status).toBe('PROCESSING');
  });
});
