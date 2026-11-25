const {
  readOnlyGuard,
  isAllowedStagingCanonDisable,
  STAGING_CANON_DISABLE_DEVICE_ID,
  STAGING_CANON_DISABLE_GIT_BRANCH
} = require('../src/middlewares/readOnlyGuard');
const {
  STAGING_SERVICE_ID,
  STAGING_SERVICE_NAME,
  STAGING_GIT_BRANCH
} = require('../src/utils/demoPaymentGuard');

describe('readOnlyGuard — exact single-device Canon staging disable exception', () => {
  const originalEnv = { ...process.env };
  const validId = STAGING_CANON_DISABLE_DEVICE_ID;
  const url = '/api/admin/printer-devices/' + validId + '/disable';
  const req = (method = 'POST', path = url, body = { reason: 'Disable Canon for controlled printer certification' }) => ({
    method, url: path, originalUrl: path, path: path.split('?')[0], baseUrl: '', body
  });
  const res = () => ({
    status: jest.fn(function (code) { this.code = code; return this; }),
    json: jest.fn(function (body) { this.body = body; return this; })
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ADMIN_READ_ONLY = 'true';
    process.env.APP_ENV = 'staging';
    process.env.RENDER = 'true';
    process.env.RENDER_SERVICE_ID = STAGING_SERVICE_ID;
    process.env.RENDER_SERVICE_NAME = STAGING_SERVICE_NAME;
    process.env.RENDER_GIT_BRANCH = STAGING_CANON_DISABLE_GIT_BRANCH;
    process.env.STAGING_CANON_DISABLE_ENABLED = 'true';
  });
  afterAll(() => { process.env = originalEnv; });

  test('allows only exact Canon ID with valid operator reason and staging identity', () => {
    expect(isAllowedStagingCanonDisable(req())).toBe(true);
    const response = res();
    const next = jest.fn();
    readOnlyGuard(req(), response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  test.each([
    ['different device ID', 'POST', '/api/admin/printer-devices/other-device/disable', { reason: 'Disable for test purpose' }],
    ['wrong method', 'PUT', url, { reason: 'Disable for test purpose' }],
    ['missing reason', 'POST', url, {}],
    ['short reason', 'POST', url, { reason: 'short' }],
    ['oversized reason', 'POST', url, { reason: 'x'.repeat(501) }],
    ['enable route', 'POST', '/api/admin/printer-devices/' + validId + '/enable', { reason: 'Enable this printer now' }],
    ['extra path segment', 'POST', url + '/extra', { reason: 'Disable for test purpose' }]
  ])('blocks %s', (_label, method, path, body) => {
    expect(isAllowedStagingCanonDisable(req(method, path, body))).toBe(false);
    const response = res();
    const next = jest.fn();
    readOnlyGuard(req(method, path, body), response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test.each([
    ['production APP_ENV', 'APP_ENV', 'production'],
    ['Render disabled', 'RENDER', 'false'],
    ['wrong Render service ID', 'RENDER_SERVICE_ID', 'srv-production'],
    ['wrong Render service name', 'RENDER_SERVICE_NAME', 'printgo-backend-production'],
    ['wrong branch', 'RENDER_GIT_BRANCH', 'main'],
    ['shared payment branch must not authorize Canon exception', 'RENDER_GIT_BRANCH', STAGING_GIT_BRANCH],
    ['feature flag missing', 'STAGING_CANON_DISABLE_ENABLED', undefined],
    ['feature flag false', 'STAGING_CANON_DISABLE_ENABLED', 'false']
  ])('fails closed for %s', (_label, key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    expect(isAllowedStagingCanonDisable(req())).toBe(false);
  });

  test('does not change normal non-read-only behavior', () => {
    process.env.ADMIN_READ_ONLY = 'false';
    const response = res();
    const next = jest.fn();
    readOnlyGuard(req(), response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });
});