/**
 * PRINTGO — READ-ONLY GUARD ADVERTISEMENT SCOPING TEST SUITE
 *
 * Verifies strict, fail-closed enforcement of ALLOW_ADVERTISEMENT_MUTATIONS
 * when ADMIN_READ_ONLY === 'true'.
 * Covers all 10 security cases.
 */

const { readOnlyGuard, isAllowedAdMutation, getCleanPath, ALLOWED_AD_MUTATION_PATTERNS } = require('../src/middlewares/readOnlyGuard');

describe('readOnlyGuard — Advertisement Scoping & Security Suite', () => {
  const origAdminReadOnly = process.env.ADMIN_READ_ONLY;
  const origAllowAdMutations = process.env.ALLOW_ADVERTISEMENT_MUTATIONS;

  afterEach(() => {
    process.env.ADMIN_READ_ONLY = origAdminReadOnly;
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

  const SEVEN_TARGET_ROUTES = [
    { method: 'POST', path: '/api/advertisements/admin' },
    { method: 'PUT', path: '/api/advertisements/admin/ad-123-uuid' },
    { method: 'PATCH', path: '/api/advertisements/admin/reorder' },
    { method: 'PATCH', path: '/api/advertisements/admin/ad-123-uuid/toggle' },
    { method: 'DELETE', path: '/api/advertisements/admin/ad-123-uuid' },
    { method: 'POST', path: '/api/machines/mach-uuid-456/ad-suppression' },
    { method: 'DELETE', path: '/api/machines/mach-uuid-456/ad-suppression' }
  ];

  // Case 1: ADMIN_READ_ONLY=true and ALLOW_ADVERTISEMENT_MUTATIONS unset
  describe('Case 1: Unset ALLOW_ADVERTISEMENT_MUTATIONS blocks all mutations', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      delete process.env.ALLOW_ADVERTISEMENT_MUTATIONS;
    });

    test.each(SEVEN_TARGET_ROUTES)('$method $path is blocked with HTTP 403', ({ method, path }) => {
      const { req, res, next } = createMockReqRes(method, path);
      readOnlyGuard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.jsonPayload.error).toContain('Read-Only Monitoring Mode');
    });
  });

  // Case 2: ADMIN_READ_ONLY=true and ALLOW_ADVERTISEMENT_MUTATIONS=false
  describe('Case 2: Explicit false ALLOW_ADVERTISEMENT_MUTATIONS blocks all mutations', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'false';
    });

    test.each(SEVEN_TARGET_ROUTES)('$method $path is blocked with HTTP 403', ({ method, path }) => {
      const { req, res, next } = createMockReqRes(method, path);
      readOnlyGuard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.jsonPayload.error).toContain('Read-Only Monitoring Mode');
    });
  });

  // Case 3: ADMIN_READ_ONLY=true and ALLOW_ADVERTISEMENT_MUTATIONS=true allows exactly the 7 routes
  describe('Case 3: Scoped allowlist permits all 7 exact advertisement routes', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'true';
    });

    test.each(SEVEN_TARGET_ROUTES)('$method $path passes to next()', ({ method, path }) => {
      const { req, res, next } = createMockReqRes(method, path);
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(res.jsonPayload).toBeNull();
    });

    test('Route mounted with baseUrl and path passes correctly', () => {
      const { req, res, next } = createMockReqRes('POST', '/api/advertisements/admin', {
        baseUrl: '/api/advertisements',
        path: '/admin'
      });
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    });
  });

  // Case 4: Unrelated admin mutations blocked even when ALLOW_ADVERTISEMENT_MUTATIONS=true
  describe('Case 4: Unrelated admin mutations remain strictly blocked', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'true';
    });

    const UNRELATED_ADMIN_ROUTES = [
      { method: 'POST', path: '/api/admin/users' },
      { method: 'POST', path: '/api/companies' },
      { method: 'PUT', path: '/api/jobs/job-123/status' },
      { method: 'POST', path: '/api/payments/refund/pay-456' },
      { method: 'POST', path: '/api/subscriptions' },
      { method: 'POST', path: '/api/subscriptions/sub-789/cancel' }
    ];

    test.each(UNRELATED_ADMIN_ROUTES)('$method $path is blocked with HTTP 403', ({ method, path }) => {
      const { req, res, next } = createMockReqRes(method, path);
      readOnlyGuard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.jsonPayload.error).toContain('Read-Only Monitoring Mode');
    });
  });

  // Case 5: Unrelated machine mutations blocked
  describe('Case 5: Unrelated machine mutations remain strictly blocked', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'true';
    });

    const UNRELATED_MACHINE_ROUTES = [
      { method: 'POST', path: '/api/machines' },
      { method: 'PUT', path: '/api/machines/mach-123' },
      { method: 'DELETE', path: '/api/machines/mach-123' }
    ];

    test.each(UNRELATED_MACHINE_ROUTES)('$method $path is blocked with HTTP 403', ({ method, path }) => {
      const { req, res, next } = createMockReqRes(method, path);
      readOnlyGuard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.jsonPayload.error).toContain('Read-Only Monitoring Mode');
    });
  });

  // Case 6: GET public reads allowed
  describe('Case 6: GET public read requests are never blocked by readOnlyGuard', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'false';
    });

    const GET_ROUTES = [
      '/api/advertisements/active',
      '/api/advertisements/active?publicCode=pq_xyz',
      '/api/machines',
      '/api/machines/mach-123/ad-suppression',
      '/api/companies',
      '/api/jobs'
    ];

    test.each(GET_ROUTES)('GET %s passes to next()', (path) => {
      const { req, res, next } = createMockReqRes('GET', path);
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    });
  });

  // Case 7: Lookalike paths blocked
  describe('Case 7: Lookalike and spoofed paths fail closed', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'true';
    });

    const LOOKALIKE_ROUTES = [
      { method: 'POST', path: '/api/advertisements/admin/extra' },
      { method: 'POST', path: '/api/advertisements/admin_fake' },
      { method: 'POST', path: '/api/advertisements/administrator' },
      { method: 'POST', path: '/api/machines/mach-123/ad-suppression/extra' },
      { method: 'POST', path: '/api/machines/mach-123/ad-suppression-fake' },
      { method: 'POST', path: '/api/machines/ad-suppression' },
      { method: 'DELETE', path: '/api/machines/ad-suppression' },
      { method: 'PATCH', path: '/api/advertisements/admin/reorder/extra' }
    ];

    test.each(LOOKALIKE_ROUTES)('$method $path is blocked with HTTP 403', ({ method, path }) => {
      const { req, res, next } = createMockReqRes(method, path);
      readOnlyGuard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });
  });

  // Case 8: Unsupported methods on valid paths blocked
  describe('Case 8: Unsupported HTTP mutation methods fail closed', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'true';
    });

    const UNSUPPORTED_METHOD_ROUTES = [
      { method: 'POST', path: '/api/advertisements/admin/reorder' }, // Reorder only allows PATCH
      { method: 'DELETE', path: '/api/advertisements/admin' }, // Root admin ad only allows POST
      { method: 'PUT', path: '/api/machines/mach-123/ad-suppression' }, // Ad-suppression only allows POST, DELETE
      { method: 'POST', path: '/api/advertisements/admin/ad-123/toggle' } // Toggle only allows PATCH
    ];

    test.each(UNSUPPORTED_METHOD_ROUTES)('$method $path is blocked with HTTP 403', ({ method, path }) => {
      const { req, res, next } = createMockReqRes(method, path);
      readOnlyGuard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });
  });

  // Case 9: Query string tricks
  describe('Case 9: Query string handling is robust and secure', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'true';
    });

    test('Valid route with query params is recognized and allowed', () => {
      const { req, res, next } = createMockReqRes('POST', '/api/advertisements/admin?timestamp=123456');
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    });

    test('Machine ad-suppression with query params is recognized and allowed', () => {
      const { req, res, next } = createMockReqRes('POST', '/api/machines/m-123/ad-suppression?notify=true');
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    });

    test('Query string trying to spoof route on unrelated path is blocked', () => {
      const { req, res, next } = createMockReqRes('POST', '/api/machines?target=/ad-suppression');
      readOnlyGuard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });
  });

  // Case 10: Encoded paths and traversal tricks
  describe('Case 10: Encoded path and traversal normalization', () => {
    beforeEach(() => {
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'true';
    });

    test('Valid route with trailing slash is properly normalized and allowed', () => {
      const { req, res, next } = createMockReqRes('POST', '/api/advertisements/admin/');
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    });

    test('Path traversal attempting to reach admin users is blocked', () => {
      const { req, res, next } = createMockReqRes('POST', '/api/advertisements/admin/../admin/users');
      readOnlyGuard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    test('Malformed URI component does not crash and fails closed', () => {
      const { req, res, next } = createMockReqRes('POST', '/api/advertisements/admin/%E0%A4%A');
      readOnlyGuard(req, res, next);

      // Malformed URI -> should safely not crash and be blocked
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });
  });
});
