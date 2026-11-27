jest.mock('../../src/utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { readOnlyGuard } = require('../../src/middlewares/readOnlyGuard');
describe('legacy QR binding routes remain blocked under ADMIN_READ_ONLY', () => {
  const original = process.env.ADMIN_READ_ONLY;
  afterAll(() => { if (original === undefined) delete process.env.ADMIN_READ_ONLY; else process.env.ADMIN_READ_ONLY = original; });
  test.each([
    '/api/admin/printer-qrs/qr-1/legacy-binding',
    '/api/admin/printer-qrs/qr-1/legacy-binding/revoke'
  ])('blocks POST %s', (url) => {
    process.env.ADMIN_READ_ONLY = 'true';
    const req = { method:'POST', url, originalUrl:url, baseUrl:'', path:url, body:{} };
    const res = { status: jest.fn(function(code){ this.code=code; return this; }), json: jest.fn(function(body){ this.body=body; return this; }) };
    const next = jest.fn();
    readOnlyGuard(req,res,next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
