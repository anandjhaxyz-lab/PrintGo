const {
  readOnlyGuard,
  isAllowedStagingLegacyQrRevoke,
  STAGING_LEGACY_QR_ID,
  STAGING_LEGACY_QR_REVOKE_PATH
} = require('../src/middlewares/readOnlyGuard');

describe('readOnlyGuard - narrowly scoped staging legacy QR revoke exception', () => {
  const originalEnv = { ...process.env };
  const validReason = 'Retiring legacy Front Desk Counter QR in favor of dedicated printer QRs';

  const makeReq = (opts = {}) => {
    const method = 'method' in opts ? opts.method : 'POST';
    const path = 'path' in opts ? opts.path : STAGING_LEGACY_QR_REVOKE_PATH;
    const body = 'body' in opts ? opts.body : { reason: validReason };
    const user = 'user' in opts ? opts.user : { id: 'admin-1', role: 'SUPERADMIN' };

    return {
      method,
      url: path,
      originalUrl: path,
      path: path.split('?')[0],
      baseUrl: '',
      body,
      user
    };
  };

  const makeRes = () => ({
    status: jest.fn(function (code) { this.code = code; return this; }),
    json: jest.fn(function (payload) { this.payload = payload; return this; })
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ADMIN_READ_ONLY = 'true';
    process.env.APP_ENV = 'staging';
    delete process.env.ALLOW_ADVERTISEMENT_MUTATIONS;
    delete process.env.ALLOW_CASH_PAYMENT_MUTATIONS;
    delete process.env.ALLOW_STAGING_PAYMENT_MODE_CONFIG;
    delete process.env.STAGING_PRINTER_APPROVALS_ENABLED;
    delete process.env.ALLOW_STAGING_PRINTER_APPROVALS;
    delete process.env.STAGING_CANON_DISABLE_ENABLED;
    delete process.env.STAGING_DEVICE_QR_CREATION_ENABLED;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test.each(['SUPERADMIN', 'FRANCHISEE'])(
    'allows exact legacy QR revoke POST path in staging for %s with valid reason',
    (role) => {
      const req = makeReq({ user: { id: 'user-1', role } });
      expect(isAllowedStagingLegacyQrRevoke(req)).toBe(true);

      const res = makeRes();
      const next = jest.fn();
      readOnlyGuard(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  );

  test('normalizes lowercase post method and trailing slash on exact legacy QR path', () => {
    const req = makeReq({
      method: 'post',
      path: `${STAGING_LEGACY_QR_REVOKE_PATH}/`
    });
    expect(isAllowedStagingLegacyQrRevoke(req)).toBe(true);

    const res = makeRes();
    const next = jest.fn();
    readOnlyGuard(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test.each([
    ['production', 'production'],
    ['missing APP_ENV', undefined],
    ['development', 'development'],
    ['test', 'test']
  ])('blocks same request when APP_ENV is %s', (_label, appEnv) => {
    if (appEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = appEnv;
    }

    const req = makeReq();
    expect(isAllowedStagingLegacyQrRevoke(req)).toBe(false);

    const res = makeRes();
    const next = jest.fn();
    readOnlyGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('predicate rejects GET and readOnlyGuard blocks PUT, DELETE, PATCH', () => {
    expect(isAllowedStagingLegacyQrRevoke(makeReq({ method: 'GET' }))).toBe(false);

    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const req = makeReq({ method });
      expect(isAllowedStagingLegacyQrRevoke(req)).toBe(false);

      const res = makeRes();
      const next = jest.fn();
      readOnlyGuard(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  test.each([
    ['missing body', undefined],
    ['null body', null],
    ['array body', ['invalid']],
    ['missing reason', {}],
    ['null reason', { reason: null }],
    ['numeric reason', { reason: 1234567890 }],
    ['object reason', { reason: { text: 'valid length string' } }],
    ['boolean reason', { reason: true }],
    ['short reason (< 10 trimmed chars)', { reason: '   short   ' }],
    ['exact 9 chars', { reason: '123456789' }],
    ['oversized reason (> 500 trimmed chars)', { reason: 'a'.repeat(501) }]
  ])('blocks invalid reason case: %s', (_label, body) => {
    const req = makeReq({ body });
    expect(isAllowedStagingLegacyQrRevoke(req)).toBe(false);

    const res = makeRes();
    const next = jest.fn();
    readOnlyGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('allows boundary reason lengths of 10 and 500 trimmed characters', () => {
    for (const reason of ['  1234567890  ', 'x'.repeat(500)]) {
      const req = makeReq({ body: { reason } });
      expect(isAllowedStagingLegacyQrRevoke(req)).toBe(true);
    }
  });

  test.each([
    ['Epson dedicated QR ID', '/api/admin/printer-qrs/a45eda5d-a1e0-459d-bb9e-1cc929bc3f57/revoke'],
    ['HP dedicated QR ID', '/api/admin/printer-qrs/32839057-070f-4867-aba6-8aea4da7dd58/revoke'],
    ['Canon dedicated QR ID', '/api/admin/printer-qrs/6afcae54-b63d-4be7-87f6-6de3e6aa3492/revoke'],
    ['arbitrary UUID', '/api/admin/printer-qrs/11111111-2222-3333-4444-555555555555/revoke'],
    ['replace route on legacy QR', `/api/admin/printer-qrs/${STAGING_LEGACY_QR_ID}/replace`],
    ['generic QR generation route', '/api/admin/printer-qrs'],
    ['device QR generation route', '/api/admin/printer-devices/619665e1-3c64-44eb-8f57-cb8c3c895e9b/qr'],
    ['extra path segment', `${STAGING_LEGACY_QR_REVOKE_PATH}/extra`]
  ])('blocks non-exact QR or non-revoke route: %s', (_label, path) => {
    const req = makeReq({ path });
    expect(isAllowedStagingLegacyQrRevoke(req)).toBe(false);

    const res = makeRes();
    const next = jest.fn();
    readOnlyGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test.each([
    ['STAFF', { id: 'u-1', role: 'STAFF' }],
    ['OPERATOR', { id: 'u-2', role: 'OPERATOR' }],
    ['CUSTOMER', { id: 'u-3', role: 'CUSTOMER' }],
    ['missing role', { id: 'u-4' }],
    ['missing user', undefined],
    ['null user', null]
  ])('blocks unauthorized role: %s', (_label, user) => {
    const req = makeReq({ user });
    expect(isAllowedStagingLegacyQrRevoke(req)).toBe(false);

    const res = makeRes();
    const next = jest.fn();
    readOnlyGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test.each([
    ['dispatch-job', 'POST', '/api/admin/dispatch-job', { shortId: '12345678' }],
    ['reconcile-job', 'POST', '/api/admin/reconcile-job', { shortId: '12345678' }],
    ['printer-devices enable', 'POST', '/api/admin/printer-devices/114c0092-e3c6-4432-b17f-e7c6f42ec334/enable', { reason: validReason }],
    ['printer-devices remap', 'POST', '/api/admin/printer-devices/114c0092-e3c6-4432-b17f-e7c6f42ec334/remap', { windowsPrinterName: 'Queue' }],
    ['reconciliation run', 'POST', '/api/admin/reconciliation/run', {}]
  ])('keeps unrelated admin mutation blocked: %s', (_label, method, path, body) => {
    const req = makeReq({ method, path, body });
    expect(isAllowedStagingLegacyQrRevoke(req)).toBe(false);

    const res = makeRes();
    const next = jest.fn();
    readOnlyGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('fails closed for malformed req object', () => {
    expect(isAllowedStagingLegacyQrRevoke(null)).toBe(false);
    expect(isAllowedStagingLegacyQrRevoke(undefined)).toBe(false);
    expect(isAllowedStagingLegacyQrRevoke('invalid')).toBe(false);
  });
});
