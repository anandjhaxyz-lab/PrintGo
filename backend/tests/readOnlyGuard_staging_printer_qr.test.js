const {
  readOnlyGuard,
  isAllowedStagingDeviceQrCreation,
  STAGING_DEVICE_QR_CREATION_GIT_BRANCH,
  STAGING_PRINTER_QR_DEVICES
} = require('../src/middlewares/readOnlyGuard');
const { STAGING_SERVICE_ID, STAGING_SERVICE_NAME } = require('../src/utils/demoPaymentGuard');

describe('readOnlyGuard - narrowly scoped staging device QR creation', () => {
  const originalEnv = { ...process.env };
  const makeReq = (method, path, body) => ({
    method,
    url: path,
    originalUrl: path,
    path: path.split('?')[0],
    baseUrl: '',
    body
  });
  const makeRes = () => ({
    status: jest.fn(function (code) { this.code = code; return this; }),
    json: jest.fn(function (body) { this.body = body; return this; })
  });
  const deviceEntries = Object.entries(STAGING_PRINTER_QR_DEVICES);
  const validPath = (id) => `/api/admin/printer-devices/${id}/qr`;
  const validBody = (label) => ({ label });

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ADMIN_READ_ONLY = 'true';
    process.env.APP_ENV = 'staging';
    process.env.RENDER = 'true';
    process.env.RENDER_SERVICE_ID = STAGING_SERVICE_ID;
    process.env.RENDER_SERVICE_NAME = STAGING_SERVICE_NAME;
    process.env.RENDER_GIT_BRANCH = STAGING_DEVICE_QR_CREATION_GIT_BRANCH;
    process.env.STAGING_DEVICE_QR_CREATION_ENABLED = 'true';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test.each(deviceEntries)('allows exact device QR creation for approved device %s', (deviceId, label) => {
    const request = makeReq('POST', validPath(deviceId), validBody(label));
    expect(isAllowedStagingDeviceQrCreation(request)).toBe(true);
    const response = makeRes();
    const next = jest.fn();

    readOnlyGuard(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  test.each([
    ['unknown device ID', 'POST', '/api/admin/printer-devices/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/qr', { label: 'Other' }],
    ['wrong label', 'POST', validPath(deviceEntries[0][0]), { label: 'Wrong printer' }],
    ['extra body property', 'POST', validPath(deviceEntries[0][0]), { label: deviceEntries[0][1], force: true }],
    ['missing label', 'POST', validPath(deviceEntries[0][0]), {}],
    ['array body', 'POST', validPath(deviceEntries[0][0]), ['unexpected']],
    ['null body', 'POST', validPath(deviceEntries[0][0]), null],
    ['generic legacy QR route', 'POST', '/api/admin/printer-qrs', { machineId: 'x', label: 'x' }],
    ['placeholder QR revoke route', 'POST', '/api/admin/printer-qrs/09363ed8-b14c-491a-aff2-c5d6c6d588f7/revoke', { reason: 'approved operator request' }],
    ['QR replace route', 'POST', '/api/admin/printer-qrs/09363ed8-b14c-491a-aff2-c5d6c6d588f7/replace', { reason: 'approved operator request' }],
    ['printer device remap route', 'POST', '/api/admin/printer-devices/114c0092-e3c6-4432-b17f-e7c6f42ec334/remap', { windowsPrinterName: 'Other queue' }],
    ['extra path segment', 'POST', validPath(deviceEntries[0][0]) + '/extra', validBody(deviceEntries[0][1])],
    ['wrong HTTP method', 'PUT', validPath(deviceEntries[0][0]), validBody(deviceEntries[0][1])]
  ])('blocks %s', (_label, method, path, body) => {
    const request = makeReq(method, path, body);
    expect(isAllowedStagingDeviceQrCreation(request)).toBe(false);
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
    ['missing dedicated feature flag', 'STAGING_DEVICE_QR_CREATION_ENABLED', undefined],
    ['disabled dedicated feature flag', 'STAGING_DEVICE_QR_CREATION_ENABLED', 'false']
  ])('fails closed for %s', (_label, key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;

    const [deviceId, label] = deviceEntries[0];
    const request = makeReq('POST', validPath(deviceId), validBody(label));
    expect(isAllowedStagingDeviceQrCreation(request)).toBe(false);
    const response = makeRes();
    const next = jest.fn();

    readOnlyGuard(request, response, next);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('keeps all mutations blocked when ADMIN_READ_ONLY is true and the QR flag is false', () => {
    process.env.STAGING_DEVICE_QR_CREATION_ENABLED = 'false';
    const [deviceId, label] = deviceEntries[0];
    const response = makeRes();
    const next = jest.fn();

    readOnlyGuard(makeReq('POST', validPath(deviceId), validBody(label)), response, next);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

});
