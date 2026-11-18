/**
 * PRINTGO — READ-ONLY GUARD CASH PAYMENT SCOPING TEST SUITE
 *
 * Verifies strict, fail-closed enforcement of ALLOW_CASH_PAYMENT_MUTATIONS
 * and APP_ENV gating when ADMIN_READ_ONLY === 'true'.
 *
 * Security Requirements:
 * 1. Cash mutation exceptions require BOTH:
 *    - process.env.APP_ENV === 'staging'
 *    - process.env.ALLOW_CASH_PAYMENT_MUTATIONS === 'true'
 * 2. If APP_ENV is missing, production, development, test or anything other than 'staging',
 *    cash exceptions remain strictly blocked with HTTP 403 even if ALLOW_CASH_PAYMENT_MUTATIONS=true.
 * 3. If ALLOW_CASH_PAYMENT_MUTATIONS is false, unset, or malformed, cash exceptions remain blocked.
 * 4. Only the two exact routes are permitted:
 *    - PUT /api/machines/:id/payment-mode
 *    - POST /api/admin/jobs/:shortId/confirm-cash
 * 5. Invalid HTTP methods on the exact paths remain blocked with HTTP 403.
 * 6. Lookalike paths, extra path segments, and traversal attempts remain blocked with HTTP 403.
 * 7. Unrelated admin mutations remain strictly blocked.
 * 8. Advertisement mutations operate independently.
 */

const {
  readOnlyGuard,
  isAllowedCashMutation,
  isAllowedAdMutation,
  getCleanPath,
  ALLOWED_CASH_MUTATION_PATTERNS,
  ALLOWED_AD_MUTATION_PATTERNS
} = require('../src/middlewares/readOnlyGuard');

describe('readOnlyGuard — Cash Payment Scoping & Security Suite', () => {
  const origAdminReadOnly = process.env.ADMIN_READ_ONLY;
  const origAppEnv = process.env.APP_ENV;
  const origAllowCashMutations = process.env.ALLOW_CASH_PAYMENT_MUTATIONS;
  const origAllowAdMutations = process.env.ALLOW_ADVERTISEMENT_MUTATIONS;

  beforeEach(() => {
    // Default safe baseline before each test
    delete process.env.ADMIN_READ_ONLY;
    delete process.env.APP_ENV;
    delete process.env.ALLOW_CASH_PAYMENT_MUTATIONS;
    delete process.env.ALLOW_ADVERTISEMENT_MUTATIONS;
  });

  afterEach(() => {
    process.env.ADMIN_READ_ONLY = origAdminReadOnly;
    process.env.APP_ENV = origAppEnv;
    process.env.ALLOW_CASH_PAYMENT_MUTATIONS = origAllowCashMutations;
    process.env.ALLOW_ADVERTISEMENT_MUTATIONS = origAllowAdMutations;
  });

  const createMockReqRes = (method, url, extra = {}) => {
    const req = {
      method,
      originalUrl: url,
      path: url.split('?')[0],
      ...extra
    };
    const res = {
      statusCode: 200,
      jsonPayload: null,
      status: function (code) {
        this.statusCode = code;
        return this;
      },
      json: function (payload) {
        this.jsonPayload = payload;
        return this;
      }
    };
    const next = jest.fn();
    return { req, res, next };
  };

  const TWO_CASH_TARGET_ROUTES = [
    { method: 'PUT', path: '/api/machines/d010496f-f176-41fe-9c98-efd2213a4a0e/payment-mode' },
    { method: 'POST', path: '/api/admin/jobs/e7a3b19c/confirm-cash' }
  ];

  // -------------------------------------------------------------------------
  // SUITE 1: Mandatory APP_ENV === 'staging' AND ALLOW_CASH_PAYMENT_MUTATIONS === 'true'
  // -------------------------------------------------------------------------
  describe('Suite 1: Dual-gate enforcement (APP_ENV === "staging" AND ALLOW_CASH_PAYMENT_MUTATIONS === "true")', () => {
    test.each(TWO_CASH_TARGET_ROUTES)(
      'Permits $method $path ONLY when APP_ENV=staging AND flag=true',
      ({ method, path }) => {
        process.env.ADMIN_READ_ONLY = 'true';
        process.env.APP_ENV = 'staging';
        process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true';

        const { req, res, next } = createMockReqRes(method, path);
        readOnlyGuard(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(200);
        expect(isAllowedCashMutation(req)).toBe(true);
      }
    );

    test.each(TWO_CASH_TARGET_ROUTES)(
      'BLOCKED in production: APP_ENV=production + flag=true blocks $method $path with 403',
      ({ method, path }) => {
        process.env.ADMIN_READ_ONLY = 'true';
        process.env.APP_ENV = 'production';
        process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true';

        const { req, res, next } = createMockReqRes(method, path);
        readOnlyGuard(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.jsonPayload).toEqual({
          success: false,
          error: 'Forbidden: Cloud Admin Dashboard is operating in Read-Only Monitoring Mode. Remote mutations are disabled.'
        });
        expect(isAllowedCashMutation(req)).toBe(false);
      }
    );

    test.each(TWO_CASH_TARGET_ROUTES)(
      'BLOCKED when APP_ENV unset: APP_ENV=undefined + flag=true blocks $method $path with 403',
      ({ method, path }) => {
        process.env.ADMIN_READ_ONLY = 'true';
        delete process.env.APP_ENV;
        process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true';

        const { req, res, next } = createMockReqRes(method, path);
        readOnlyGuard(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(isAllowedCashMutation(req)).toBe(false);
      }
    );

    test.each(TWO_CASH_TARGET_ROUTES)(
      'BLOCKED in development: APP_ENV=development + flag=true blocks $method $path with 403',
      ({ method, path }) => {
        process.env.ADMIN_READ_ONLY = 'true';
        process.env.APP_ENV = 'development';
        process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true';

        const { req, res, next } = createMockReqRes(method, path);
        readOnlyGuard(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(isAllowedCashMutation(req)).toBe(false);
      }
    );

    test.each(TWO_CASH_TARGET_ROUTES)(
      'BLOCKED in test env: APP_ENV=test + flag=true blocks $method $path with 403',
      ({ method, path }) => {
        process.env.ADMIN_READ_ONLY = 'true';
        process.env.APP_ENV = 'test';
        process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true';

        const { req, res, next } = createMockReqRes(method, path);
        readOnlyGuard(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(isAllowedCashMutation(req)).toBe(false);
      }
    );

    test.each(TWO_CASH_TARGET_ROUTES)(
      'BLOCKED when flag=false: APP_ENV=staging + flag=false blocks $method $path with 403',
      ({ method, path }) => {
        process.env.ADMIN_READ_ONLY = 'true';
        process.env.APP_ENV = 'staging';
        process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'false';

        const { req, res, next } = createMockReqRes(method, path);
        readOnlyGuard(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(isAllowedCashMutation(req)).toBe(false);
      }
    );

    test.each(TWO_CASH_TARGET_ROUTES)(
      'BLOCKED when flag unset: APP_ENV=staging + flag unset blocks $method $path with 403',
      ({ method, path }) => {
        process.env.ADMIN_READ_ONLY = 'true';
        process.env.APP_ENV = 'staging';
        delete process.env.ALLOW_CASH_PAYMENT_MUTATIONS;

        const { req, res, next } = createMockReqRes(method, path);
        readOnlyGuard(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(isAllowedCashMutation(req)).toBe(false);
      }
    );

    test('BLOCKED on malformed flag: APP_ENV=staging + flag="1" does not bypass guard', () => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.APP_ENV = 'staging';
      process.env.ALLOW_CASH_PAYMENT_MUTATIONS = '1';

      const { req, res, next } = createMockReqRes('PUT', '/api/machines/mach-1/payment-mode');
      readOnlyGuard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(isAllowedCashMutation(req)).toBe(false);
    });

    test('BLOCKED on malformed flag: APP_ENV=staging + flag="true " with trailing whitespace', () => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.APP_ENV = 'staging';
      process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true ';

      const { req, res, next } = createMockReqRes('PUT', '/api/machines/mach-1/payment-mode');
      readOnlyGuard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(isAllowedCashMutation(req)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // SUITE 2: Target route variations permitted in staging with flag=true
  // -------------------------------------------------------------------------
  describe('Suite 2: Target route variations permitted in staging with flag=true', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.APP_ENV = 'staging';
      process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true';
    });

    test.each(TWO_CASH_TARGET_ROUTES)(
      'Allowed: $method $path calls next() without error',
      ({ method, path }) => {
        const { req, res, next } = createMockReqRes(method, path);
        readOnlyGuard(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(200);
        expect(isAllowedCashMutation(req)).toBe(true);
      }
    );

    test('Allowed with query parameters: PUT /api/machines/mach-123/payment-mode?dryRun=true', () => {
      const { req, res, next } = createMockReqRes('PUT', '/api/machines/mach-123/payment-mode?dryRun=true');
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(isAllowedCashMutation(req)).toBe(true);
    });

    test('Allowed with URL fragments: POST /api/admin/jobs/j12345/confirm-cash#audit', () => {
      const { req, res, next } = createMockReqRes('POST', '/api/admin/jobs/j12345/confirm-cash#audit');
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(isAllowedCashMutation(req)).toBe(true);
    });

    test('Allowed with redundant slashes: PUT /api/machines//m123///payment-mode/', () => {
      const { req, res, next } = createMockReqRes('PUT', '/api/machines//m123///payment-mode/');
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(isAllowedCashMutation(req)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // SUITE 3: Invalid HTTP methods on target routes remain blocked
  // -------------------------------------------------------------------------
  describe('Suite 3: Invalid HTTP methods on target routes remain blocked even in staging', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.APP_ENV = 'staging';
      process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true';
    });

    const INVALID_METHOD_CASES = [
      { method: 'POST', path: '/api/machines/mach-123/payment-mode' },
      { method: 'PATCH', path: '/api/machines/mach-123/payment-mode' },
      { method: 'DELETE', path: '/api/machines/mach-123/payment-mode' },
      { method: 'PUT', path: '/api/admin/jobs/j123/confirm-cash' },
      { method: 'PATCH', path: '/api/admin/jobs/j123/confirm-cash' },
      { method: 'DELETE', path: '/api/admin/jobs/j123/confirm-cash' }
    ];

    test.each(INVALID_METHOD_CASES)(
      'Invalid method $method on $path is blocked with HTTP 403',
      ({ method, path }) => {
        const { req, res, next } = createMockReqRes(method, path);
        readOnlyGuard(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(isAllowedCashMutation(req)).toBe(false);
      }
    );
  });

  // -------------------------------------------------------------------------
  // SUITE 4: Lookalike, missing segment, or trailing segment paths remain blocked
  // -------------------------------------------------------------------------
  describe('Suite 4: Lookalike, missing segment, or trailing segment paths remain blocked', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.APP_ENV = 'staging';
      process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true';
    });

    const LOOKALIKE_CASES = [
      // Missing required parameter segment
      { method: 'PUT', path: '/api/machines/payment-mode' },
      { method: 'POST', path: '/api/admin/jobs/confirm-cash' },
      // Extra trailing segments
      { method: 'PUT', path: '/api/machines/mach-123/payment-mode/extra' },
      { method: 'PUT', path: '/api/machines/mach-123/payment-mode/status' },
      { method: 'POST', path: '/api/admin/jobs/j123/confirm-cash/receipt' },
      { method: 'POST', path: '/api/admin/jobs/j123/confirm-cash/cancel' },
      // Suffix lookalikes
      { method: 'PUT', path: '/api/machines/mach-123/payment-mode-other' },
      { method: 'POST', path: '/api/admin/jobs/j123/confirm-cash-fake' },
      // Prefix lookalikes
      { method: 'PUT', path: '/api/machines/mach-123/fake-payment-mode' },
      { method: 'POST', path: '/api/admin/jobs/j123/pre-confirm-cash' },
      // Traversal / subpath injection attempts
      { method: 'PUT', path: '/api/machines/mach-123/payment-mode/../../delete' },
      { method: 'POST', path: '/api/admin/jobs/j123/confirm-cash/../../dispatch' }
    ];

    test.each(LOOKALIKE_CASES)(
      'Lookalike $method $path is blocked with HTTP 403',
      ({ method, path }) => {
        const { req, res, next } = createMockReqRes(method, path);
        readOnlyGuard(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(isAllowedCashMutation(req)).toBe(false);
      }
    );
  });

  // -------------------------------------------------------------------------
  // SUITE 5: Unrelated admin mutations remain strictly blocked
  // -------------------------------------------------------------------------
  describe('Suite 5: Unrelated admin mutations remain strictly blocked even in staging', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.APP_ENV = 'staging';
      process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true';
      delete process.env.ALLOW_ADVERTISEMENT_MUTATIONS;
    });

    const UNRELATED_ADMIN_MUTATIONS = [
      // Print job dispatch & queue actions
      { method: 'POST', path: '/api/admin/dispatch-job' },
      // Payment refunds & ledger mutations
      { method: 'POST', path: '/api/payments/refund' },
      { method: 'POST', path: '/api/payments/create-order' },
      // Machine management mutations
      { method: 'POST', path: '/api/machines' },
      { method: 'PUT', path: '/api/machines/mach-123' },
      { method: 'DELETE', path: '/api/machines/mach-123' },
      // Company management mutations
      { method: 'POST', path: '/api/companies' },
      { method: 'PUT', path: '/api/companies/comp-456' },
      { method: 'DELETE', path: '/api/companies/comp-456' },
      // Subscriptions & pricing mutations
      { method: 'POST', path: '/api/subscriptions/plans' },
      { method: 'PUT', path: '/api/subscriptions/comp-456/quota' },
      // Advertisement mutations when ALLOW_ADVERTISEMENT_MUTATIONS is unset
      { method: 'POST', path: '/api/advertisements/admin' },
      { method: 'PUT', path: '/api/advertisements/admin/ad-1' },
      { method: 'DELETE', path: '/api/advertisements/admin/ad-1' }
    ];

    test.each(UNRELATED_ADMIN_MUTATIONS)(
      'Unrelated mutation $method $path remains blocked with HTTP 403',
      ({ method, path }) => {
        const { req, res, next } = createMockReqRes(method, path);
        readOnlyGuard(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(isAllowedCashMutation(req)).toBe(false);
      }
    );
  });

  // -------------------------------------------------------------------------
  // SUITE 6: Advertisement controls independence & coexistence
  // -------------------------------------------------------------------------
  describe('Suite 6: Advertisement controls operate independently and coexist correctly', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.APP_ENV = 'staging';
    });

    test('Both ALLOW_CASH_PAYMENT_MUTATIONS and ALLOW_ADVERTISEMENT_MUTATIONS work concurrently in staging', () => {
      process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true';
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'true';

      // Cash route allowed
      const cashCheck = createMockReqRes('POST', '/api/admin/jobs/j123/confirm-cash');
      readOnlyGuard(cashCheck.req, cashCheck.res, cashCheck.next);
      expect(cashCheck.next).toHaveBeenCalledTimes(1);

      // Ad route allowed
      const adCheck = createMockReqRes('POST', '/api/advertisements/admin');
      readOnlyGuard(adCheck.req, adCheck.res, adCheck.next);
      expect(adCheck.next).toHaveBeenCalledTimes(1);

      // Unrelated dispatch route still blocked
      const dispatchCheck = createMockReqRes('POST', '/api/admin/dispatch-job');
      readOnlyGuard(dispatchCheck.req, dispatchCheck.res, dispatchCheck.next);
      expect(dispatchCheck.next).not.toHaveBeenCalled();
      expect(dispatchCheck.res.statusCode).toBe(403);
    });

    test('ALLOW_ADVERTISEMENT_MUTATIONS=true does NOT allow cash mutations', () => {
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'true';
      delete process.env.ALLOW_CASH_PAYMENT_MUTATIONS;

      const { req, res, next } = createMockReqRes('POST', '/api/admin/jobs/j123/confirm-cash');
      readOnlyGuard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    test('In production: ALLOW_ADVERTISEMENT_MUTATIONS=true still works, but cash remains blocked', () => {
      process.env.APP_ENV = 'production';
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'true';
      process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true'; // must be ignored because APP_ENV != staging

      // Cash route blocked because APP_ENV=production
      const cashCheck = createMockReqRes('POST', '/api/admin/jobs/j123/confirm-cash');
      readOnlyGuard(cashCheck.req, cashCheck.res, cashCheck.next);
      expect(cashCheck.next).not.toHaveBeenCalled();
      expect(cashCheck.res.statusCode).toBe(403);

      // Ad route allowed (as ad controls are not restricted to staging)
      const adCheck = createMockReqRes('POST', '/api/advertisements/admin');
      readOnlyGuard(adCheck.req, adCheck.res, adCheck.next);
      expect(adCheck.next).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // SUITE 7: Read-only GET requests pass through freely
  // -------------------------------------------------------------------------
  describe('Suite 7: GET requests pass through unhindered', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      delete process.env.ALLOW_CASH_PAYMENT_MUTATIONS;
    });

    const GET_ROUTES = [
      '/api/machines/mach-123/payment-mode',
      '/api/admin/jobs',
      '/api/admin/stats',
      '/api/admin/audit-logs',
      '/api/pricing/public'
    ];

    test.each(GET_ROUTES)('GET %s passes through to next()', (path) => {
      const { req, res, next } = createMockReqRes('GET', path);
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // SUITE 8: Inactive ADMIN_READ_ONLY passes all requests
  // -------------------------------------------------------------------------
  describe('Suite 8: Inactive ADMIN_READ_ONLY passes all requests through', () => {
    test('When ADMIN_READ_ONLY=false, all mutations pass through', () => {
      process.env.ADMIN_READ_ONLY = 'false';
      delete process.env.ALLOW_CASH_PAYMENT_MUTATIONS;

      const { req, res, next } = createMockReqRes('POST', '/api/admin/jobs/j123/confirm-cash');
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    test('When ADMIN_READ_ONLY is unset, all mutations pass through', () => {
      delete process.env.ADMIN_READ_ONLY;
      delete process.env.ALLOW_CASH_PAYMENT_MUTATIONS;

      const { req, res, next } = createMockReqRes('PUT', '/api/machines/mach-123/payment-mode');
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
