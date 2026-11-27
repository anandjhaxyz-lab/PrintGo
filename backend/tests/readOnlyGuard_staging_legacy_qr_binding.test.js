const {
  readOnlyGuard,
  isAllowedStagingLegacyQrBindingMutation,
  STAGING_LEGACY_QR_BINDING_GIT_BRANCH
} = require('../src/middlewares/readOnlyGuard');
const { STAGING_SERVICE_ID, STAGING_SERVICE_NAME } = require('../src/utils/demoPaymentGuard');

describe('readOnlyGuard - exact staging legacy QR binding mutations', () => {
  const originalEnv = { ...process.env };
  const qrId = '09363ed8-b14c-491a-aff2-c5d6c6d588f7';
  const deviceId = '619665e1-3c64-44eb-8f57-cb8c3c895e9b';
  const path = (suffix = '') => `/api/admin/printer-qrs/${qrId}/legacy-binding${suffix}`;
  const request = (method = 'POST', url = path(), body = { printerDeviceId: deviceId, reason: 'Approved audited alias' }, role = 'SUPERADMIN') => ({
    method, url, originalUrl: url, path: url.split('?')[0], baseUrl: '', body, user: { role }
  });
  const response = () => ({
    status: jest.fn(function (code) { this.code = code; return this; }),
    json: jest.fn(function (body) { this.body = body; return this; })
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    Object.assign(process.env, {
      ADMIN_READ_ONLY: 'true',
      APP_ENV: 'staging',
      RENDER: 'true',
      RENDER_SERVICE_ID: STAGING_SERVICE_ID,
      RENDER_SERVICE_NAME: STAGING_SERVICE_NAME,
      RENDER_GIT_BRANCH: STAGING_LEGACY_QR_BINDING_GIT_BRANCH,
      STAGING_LEGACY_QR_BINDINGS_ENABLED: 'true'
    });
  });
  afterAll(() => { process.env = originalEnv; });

  test('allows exact SUPERADMIN approval route and body', () => {
    const req = request();
    expect(isAllowedStagingLegacyQrBindingMutation(req)).toBe(true);
    const res = response(); const next = jest.fn();
    readOnlyGuard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('allows exact SUPERADMIN revoke route and reason-only body', () => {
    const req = request('POST', path('/revoke'), { reason: 'Revoked after audited review' });
    expect(isAllowedStagingLegacyQrBindingMutation(req)).toBe(true);
    const res = response(); const next = jest.fn();
    readOnlyGuard(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test.each([
    ['nine non-whitespace characters separated by spaces', 'abc def ghi', false],
    ['ten non-whitespace characters separated by spaces', 'abc def ghij', true],
    ['ten non-whitespace characters with tabs and newline', 'abc\tdef\nghij', true],
    ['whitespace-only reason', '          ', false]
  ])('validates meaningful reason length: %s', (_label, reason, expected) => {
    const approval = request('POST', path(), { printerDeviceId: deviceId, reason });
    const revocation = request('POST', path('/revoke'), { reason });
    expect(isAllowedStagingLegacyQrBindingMutation(approval)).toBe(expected);
    expect(isAllowedStagingLegacyQrBindingMutation(revocation)).toBe(expected);
  });

  test.each([
    ['production app', 'APP_ENV', 'production'],
    ['Render disabled', 'RENDER', 'false'],
    ['wrong service ID', 'RENDER_SERVICE_ID', 'srv-production'],
    ['wrong service name', 'RENDER_SERVICE_NAME', 'printgo-backend-production'],
    ['wrong branch', 'RENDER_GIT_BRANCH', 'main'],
    ['feature flag absent', 'STAGING_LEGACY_QR_BINDINGS_ENABLED', undefined],
    ['feature flag disabled', 'STAGING_LEGACY_QR_BINDINGS_ENABLED', 'false']
  ])('fails closed when %s', (_label, key, value) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    expect(isAllowedStagingLegacyQrBindingMutation(request())).toBe(false);
  });

  test.each([
    ['non-superadmin', request('POST', path(), { printerDeviceId: deviceId, reason: 'Approved audited alias' }, 'FRANCHISEE')],
    ['wrong method', request('PUT')],
    ['generic legacy QR endpoint', request('POST', '/api/admin/printer-qrs', { printerDeviceId: deviceId, reason: 'Approved audited alias' })],
    ['QR revoke endpoint', request('POST', `/api/admin/printer-qrs/${qrId}/revoke`, { reason: 'Approved audited alias' })],
    ['extra path segment', request('POST', path('/revoke/extra'), { reason: 'Approved audited alias' })],
    ['short reason', request('POST', path(), { printerDeviceId: deviceId, reason: 'short' })],
    ['extra body property', request('POST', path(), { printerDeviceId: deviceId, reason: 'Approved audited alias', force: true })],
    ['missing target device', request('POST', path(), { reason: 'Approved audited alias' })],
    ['array body', request('POST', path(), [{ reason: 'Approved audited alias' }])]
  ])('blocks %s', (_label, req) => {
    expect(isAllowedStagingLegacyQrBindingMutation(req)).toBe(false);
    const res = response(); const next = jest.fn();
    readOnlyGuard(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('blocks all legacy binding mutations when ADMIN_READ_ONLY is not active only through the exception path', () => {
    process.env.STAGING_LEGACY_QR_BINDINGS_ENABLED = 'false';
    const req = request();
    expect(isAllowedStagingLegacyQrBindingMutation(req)).toBe(false);
  });
});
