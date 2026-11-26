const {
  readOnlyGuard,
  isAllowedStagingPrinterQrMutation,
  STAGING_PLACEHOLDER_QR_ID,
  STAGING_PRINTER_QR_DEVICES,
  STAGING_PRINTER_QR_GIT_BRANCH
} = require('../src/middlewares/readOnlyGuard');
const { STAGING_SERVICE_ID, STAGING_SERVICE_NAME } = require('../src/utils/demoPaymentGuard');

describe('readOnlyGuard - exact staging printer QR mutation exception', () => {
  const originalEnv = { ...process.env };
  const revokePath = `/api/admin/printer-qrs/${STAGING_PLACEHOLDER_QR_ID}/revoke`;
  const reason = 'Replace placeholder QR with dedicated printer mappings';
  const makeReq = (method, path, body) => ({ method, url: path, originalUrl: path, path: path.split('?')[0], baseUrl: '', body });
  const makeRes = () => ({
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
    process.env.RENDER_GIT_BRANCH = STAGING_PRINTER_QR_GIT_BRANCH;
    process.env.STAGING_PRINTER_QR_MUTATIONS_ENABLED = 'true';
  });
  afterAll(() => { process.env = originalEnv; });

  test('allows only revocation of the exact placeholder QR with a valid reason', () => {
    const request = makeReq('POST', revokePath, { reason });
    expect(isAllowedStagingPrinterQrMutation(request)).toBe(true);
    const response = makeRes();
    const next = jest.fn();
    readOnlyGuard(request, response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  test.each(Object.entries(STAGING_PRINTER_QR_DEVICES))('allows exact device QR creation for %s', (deviceId, label) => {
    const request = makeReq('POST', `/api/admin/printer-devices/${deviceId}/qr`, { label });
    expect(isAllowedStagingPrinterQrMutation(request)).toBe(true);
    const response = makeRes();
    const next = jest.fn();
    readOnlyGuard(request, response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  test.each([
    ['other QR revoke ID', 'POST', '/api/admin/printer-qrs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/revoke', { reason }],
    ['generic QR creation route', 'POST', '/api/admin/printer-qrs', { machineId: 'x', label: 'x' }],
    ['QR replacement route', 'POST', `/api/admin/printer-qrs/${STAGING_PLACEHOLDER_QR_ID}/replace`, { reason }],
    ['unapproved device ID', 'POST', '/api/admin/printer-devices/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/qr', { label: 'Other' }],
    ['wrong label for approved device', 'POST', `/api/admin/printer-devices/${Object.keys(STAGING_PRINTER_QR_DEVICES)[0]}/qr`, { label: 'Wrong label' }],
    ['extra body field on create', 'POST', `/api/admin/printer-devices/${Object.keys(STAGING_PRINTER_QR_DEVICES)[0]}/qr`, { label: Object.values(STAGING_PRINTER_QR_DEVICES)[0], force: true }],
    ['wrong method', 'PUT', revokePath, { reason }],
    ['extra path segment', 'POST', `${revokePath}/extra`, { reason }],
    ['missing reason', 'POST', revokePath, {}],
    ['short reason', 'POST', revokePath, { reason: 'too short' }],
    ['oversized reason', 'POST', revokePath, { reason: 'x'.repeat(501) }],
    ['extra body field on revoke', 'POST', revokePath, { reason, confirm: true }]
  ])('blocks %s', (_label, method, path, body) => {
    const request = makeReq(method, path, body);
    expect(isAllowedStagingPrinterQrMutation(request)).toBe(false);
    const response = makeRes();
    const next = jest.fn();
    readOnlyGuard(request, response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test.each([
    ['wrong APP_ENV', 'APP_ENV', 'production'],
    ['Render disabled', 'RENDER', 'false'],
    ['wrong service ID', 'RENDER_SERVICE_ID', 'srv-production'],
    ['wrong service name', 'RENDER_SERVICE_NAME', 'printgo-backend-production'],
    ['wrong branch', 'RENDER_GIT_BRANCH', 'main'],
    ['missing feature flag', 'STAGING_PRINTER_QR_MUTATIONS_ENABLED', undefined],
    ['false feature flag', 'STAGING_PRINTER_QR_MUTATIONS_ENABLED', 'false']
  ])('fails closed for %s', (_label, key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    expect(isAllowedStagingPrinterQrMutation(makeReq('POST', revokePath, { reason }))).toBe(false);
  });

  test('keeps all mutations blocked when ADMIN_READ_ONLY is true and QR feature flag is false', () => {
    process.env.STAGING_PRINTER_QR_MUTATIONS_ENABLED = 'false';
    const request = makeReq('POST', `/api/admin/printer-devices/${Object.keys(STAGING_PRINTER_QR_DEVICES)[0]}/qr`, { label: Object.values(STAGING_PRINTER_QR_DEVICES)[0] });
    const response = makeRes();
    const next = jest.fn();
    readOnlyGuard(request, response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
