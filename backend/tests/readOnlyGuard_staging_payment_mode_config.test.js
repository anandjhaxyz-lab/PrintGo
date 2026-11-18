/**
 * PRINTGO — NARROW STAGING PAYMENT MODE CONFIGURATION GUARD TESTS
 *
 * Verifies strict, fail-closed enforcement of the dedicated Staging permission:
 * ALLOW_STAGING_PAYMENT_MODE_CONFIG and STAGING_PAYMENT_MODE_ALLOWED_MACHINE_ID
 *
 * Requires ALL 10 conditions to permit mutation when ADMIN_READ_ONLY === 'true':
 * 1. APP_ENV is exactly 'staging'
 * 2. RENDER is exactly 'true'
 * 3. RENDER_SERVICE_ID matches 'srv-dbqpapon74is73csbc80'
 * 4. RENDER_SERVICE_NAME matches 'printgo-backend-staging'
 * 5. RENDER_GIT_BRANCH matches 'feature/printgo-production-readiness'
 * 6. ALLOW_STAGING_PAYMENT_MODE_CONFIG is exactly 'true'
 * 7. Requested machine ID matches STAGING_PAYMENT_MODE_ALLOWED_MACHINE_ID
 * 8. HTTP method is PUT
 * 9. Normalized path matches /api/machines/{allowedMachineId}/payment-mode
 * 10. Requested paymentMode is exactly 'DEMO_SIMULATION'
 */

const {
  readOnlyGuard,
  isAllowedStagingPaymentModeConfig
} = require('../src/middlewares/readOnlyGuard');
const {
  STAGING_SERVICE_ID,
  STAGING_SERVICE_NAME,
  STAGING_GIT_BRANCH
} = require('../src/utils/demoPaymentGuard');

describe('readOnlyGuard — Staging Payment Mode Narrow Config Guard', () => {
  const TARGET_MACHINE_ID = 'd010496f-f176-41fe-9c98-efd2213a4a0e';

  const origEnv = { ...process.env };

  const setValidStagingConfig = () => {
    process.env.ADMIN_READ_ONLY = 'true';
    process.env.APP_ENV = 'staging';
    process.env.RENDER = 'true';
    process.env.RENDER_SERVICE_ID = STAGING_SERVICE_ID;
    process.env.RENDER_SERVICE_NAME = STAGING_SERVICE_NAME;
    process.env.RENDER_GIT_BRANCH = STAGING_GIT_BRANCH;
    process.env.ALLOW_STAGING_PAYMENT_MODE_CONFIG = 'true';
    process.env.STAGING_PAYMENT_MODE_ALLOWED_MACHINE_ID = TARGET_MACHINE_ID;
  };

  const createMockReqRes = (method, path, body) => {
    const req = {
      method,
      url: path,
      path,
      originalUrl: path,
      body: body !== undefined ? body : { paymentMode: 'DEMO_SIMULATION' },
      headers: {}
    };

    let statusCode = null;
    let jsonBody = null;
    let nextCalled = false;

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        jsonBody = data;
        return this;
      }
    };

    const next = () => {
      nextCalled = true;
    };

    return { req, res, next, getStatusCode: () => statusCode, getJsonBody: () => jsonBody, isNextCalled: () => nextCalled };
  };

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.ALLOW_CASH_PAYMENT_MUTATIONS;
    delete process.env.ALLOW_ADVERTISEMENT_MUTATIONS;
    setValidStagingConfig();
  });

  afterAll(() => {
    process.env = { ...origEnv };
  });

  describe('Positive Case', () => {
    test('Permits PUT /api/machines/:allowedMachineId/payment-mode with DEMO_SIMULATION when all 10 conditions match', () => {
      const { req, res, next, isNextCalled } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(true);

      readOnlyGuard(req, res, next);
      expect(isNextCalled()).toBe(true);
    });

    test('Permits the actual mounted Express router path using baseUrl + path', () => {
      const { req, res, next, isNextCalled } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );
      // Express router middleware sees the mount path and the remaining route path separately.
      req.baseUrl = '/api/machines';
      req.path = `/${TARGET_MACHINE_ID}/payment-mode`;
      req.originalUrl = `/api/machines/${TARGET_MACHINE_ID}/payment-mode`;

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(true);
      readOnlyGuard(req, res, next);
      expect(isNextCalled()).toBe(true);
    });

    test('Permits with query string on normalized path', () => {
      const { req, res, next, isNextCalled } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode?source=admin`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(true);

      readOnlyGuard(req, res, next);
      expect(isNextCalled()).toBe(true);
    });
  });

  describe('Negative Cases — Environment Boundary Fails Closed', () => {
    test('Condition 1 Fail: BLOCKED when APP_ENV is production', () => {
      process.env.APP_ENV = 'production';
      const { req, res, next, getStatusCode, isNextCalled } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(isNextCalled()).toBe(false);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 1 Fail: BLOCKED when APP_ENV is unset', () => {
      delete process.env.APP_ENV;
      const { req, res, next, getStatusCode, isNextCalled } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(isNextCalled()).toBe(false);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 2 Fail: BLOCKED when RENDER is not true', () => {
      process.env.RENDER = 'false';
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 3 Fail: BLOCKED when RENDER_SERVICE_ID does not match', () => {
      process.env.RENDER_SERVICE_ID = 'srv-production-unauthorized-id';
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 4 Fail: BLOCKED when RENDER_SERVICE_NAME does not match', () => {
      process.env.RENDER_SERVICE_NAME = 'printgo-backend-production';
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 5 Fail: BLOCKED when RENDER_GIT_BRANCH does not match', () => {
      process.env.RENDER_GIT_BRANCH = 'master';
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 6 Fail: BLOCKED when ALLOW_STAGING_PAYMENT_MODE_CONFIG is unset', () => {
      delete process.env.ALLOW_STAGING_PAYMENT_MODE_CONFIG;
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 6 Fail: BLOCKED when ALLOW_STAGING_PAYMENT_MODE_CONFIG is false or non-true', () => {
      process.env.ALLOW_STAGING_PAYMENT_MODE_CONFIG = 'false';
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 7 Fail: BLOCKED when STAGING_PAYMENT_MODE_ALLOWED_MACHINE_ID is unset', () => {
      delete process.env.STAGING_PAYMENT_MODE_ALLOWED_MACHINE_ID;
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 7 Fail: BLOCKED when machine ID does not match configured allowed ID', () => {
      const DIFFERENT_MACHINE = 'e9999999-9999-9999-9999-999999999999';
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${DIFFERENT_MACHINE}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });
  });

  describe('Negative Cases — Scope and Request Restrictions', () => {
    test('Condition 8 Fail: BLOCKED for POST method', () => {
      const { req, res, next, getStatusCode } = createMockReqRes(
        'POST',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 8 Fail: BLOCKED for PATCH method', () => {
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PATCH',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 8 Fail: BLOCKED for DELETE method', () => {
      const { req, res, next, getStatusCode } = createMockReqRes(
        'DELETE',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 9 Fail: BLOCKED for different machine endpoint', () => {
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 9 Fail: BLOCKED for lookalike or extra path segments', () => {
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode/status`,
        { paymentMode: 'DEMO_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 10 Fail: BLOCKED when requested mode is CASHFREE_ONLINE', () => {
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'CASHFREE_ONLINE' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 10 Fail: BLOCKED when requested mode is CASH_AT_COUNTER', () => {
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'CASH_AT_COUNTER' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 10 Fail: BLOCKED when body is missing or empty', () => {
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        {}
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Condition 10 Fail: BLOCKED when body contains invalid paymentMode', () => {
      const { req, res, next, getStatusCode } = createMockReqRes(
        'PUT',
        `/api/machines/${TARGET_MACHINE_ID}/payment-mode`,
        { paymentMode: 'UNAUTHORIZED_SIMULATION' }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });

    test('Independence: Does NOT authorize jobs confirm-cash route', () => {
      const { req, res, next, getStatusCode } = createMockReqRes(
        'POST',
        `/api/admin/jobs/job-123/confirm-cash`,
        { amount: 10 }
      );

      expect(isAllowedStagingPaymentModeConfig(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(getStatusCode()).toBe(403);
    });
  });
});
