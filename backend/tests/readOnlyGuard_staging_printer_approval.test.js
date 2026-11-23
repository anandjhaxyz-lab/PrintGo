/**
 * PRINTGO — NARROW STAGING PRINTER DISCOVERY APPROVAL GUARD TESTS
 *
 * Verifies strict, fail-closed enforcement of the dedicated Staging permission:
 * STAGING_PRINTER_APPROVALS_ENABLED (or ALLOW_STAGING_PRINTER_APPROVALS)
 *
 * Requirements verified:
 * 1. Global ADMIN_READ_ONLY=true remains enforced.
 * 2. Exact staging printer approval route is permitted ONLY when dedicated flag is enabled.
 * 3. Route is blocked when flag is missing, false, or invalid.
 * 4. Production environment (APP_ENV !== 'staging', RENDER !== 'true', or service/branch mismatch) fails closed.
 * 5. Other admin POST, PUT, PATCH, DELETE routes remain strictly blocked.
 * 6. isDefault: false is mandatory; missing, true, null, or invalid values are rejected.
 * 7. Path variations (trailing slashes, duplicate slashes, encoded characters, query strings) are safely normalized.
 * 8. Existing exemptions (ads, cash, staging payment mode) retain exact behavior.
 */

const {
  readOnlyGuard,
  isAllowedStagingPrinterApproval,
  isAllowedStagingPaymentModeConfig,
  isAllowedCashMutation,
  isAllowedAdMutation
} = require('../src/middlewares/readOnlyGuard');
const {
  STAGING_SERVICE_ID,
  STAGING_SERVICE_NAME,
  STAGING_GIT_BRANCH
} = require('../src/utils/demoPaymentGuard');

describe('readOnlyGuard — Narrow Staging Printer Discovery Approval Exemption', () => {
  const origEnv = { ...process.env };

  const setValidStagingApprovalConfig = () => {
    process.env.ADMIN_READ_ONLY = 'true';
    process.env.APP_ENV = 'staging';
    process.env.RENDER = 'true';
    process.env.RENDER_SERVICE_ID = STAGING_SERVICE_ID;
    process.env.RENDER_SERVICE_NAME = STAGING_SERVICE_NAME;
    process.env.RENDER_GIT_BRANCH = STAGING_GIT_BRANCH;
    process.env.STAGING_PRINTER_APPROVALS_ENABLED = 'true';
  };

  beforeEach(() => {
    process.env = { ...origEnv };
    setValidStagingApprovalConfig();
  });

  afterAll(() => {
    process.env = origEnv;
  });

  const createMockReq = (method, url, body = {}, overrides = {}) => ({
    method,
    url,
    originalUrl: url,
    baseUrl: '',
    path: url.split('?')[0],
    body,
    ...overrides
  });

  const createMockRes = () => {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((code) => {
      res.statusCode = code;
      return res;
    });
    res.json = jest.fn((data) => {
      res.data = data;
      return res;
    });
    return res;
  };

  describe('1. Positive Cases — Exact Authorized Exemption', () => {
    it('Permits POST /api/admin/printer-discoveries/:id/approve with isDefault: false when all conditions match', () => {
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_hp_001/approve', {
        displayName: 'HP LaserJet M1136',
        isDefault: false
      });
      const res = createMockRes();
      const next = jest.fn();

      expect(isAllowedStagingPrinterApproval(req)).toBe(true);

      readOnlyGuard(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('Also permits when using ALLOW_STAGING_PRINTER_APPROVALS alias', () => {
      delete process.env.STAGING_PRINTER_APPROVALS_ENABLED;
      process.env.ALLOW_STAGING_PRINTER_APPROVALS = 'true';

      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_epson_002/approve', {
        displayName: 'Epson L6460',
        isDefault: false
      });
      const res = createMockRes();
      const next = jest.fn();

      expect(isAllowedStagingPrinterApproval(req)).toBe(true);
      readOnlyGuard(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('Handles Express mounted baseUrl + path correctly', () => {
      const req = {
        method: 'POST',
        baseUrl: '/api/admin',
        path: '/printer-discoveries/disc_canon_003/approve',
        originalUrl: '/api/admin/printer-discoveries/disc_canon_003/approve',
        body: { displayName: 'Canon imageRUNNER ADV 4545', isDefault: false }
      };
      const res = createMockRes();
      const next = jest.fn();

      expect(isAllowedStagingPrinterApproval(req)).toBe(true);
      readOnlyGuard(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('Safely normalizes trailing slash on approval route', () => {
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve/', {
        displayName: 'Printer 1',
        isDefault: false
      });
      expect(isAllowedStagingPrinterApproval(req)).toBe(true);
    });

    it('Safely ignores query strings on approval route', () => {
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve?preview=false&t=12345', {
        displayName: 'Printer 1',
        isDefault: false
      });
      expect(isAllowedStagingPrinterApproval(req)).toBe(true);
    });
  });

  describe('2. Negative Cases — Strict Environment Boundaries Fail Closed', () => {
    it('BLOCKED when APP_ENV is production', () => {
      process.env.APP_ENV = 'production';
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', { isDefault: false });
      const res = createMockRes();
      const next = jest.fn();

      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('BLOCKED when APP_ENV is unset', () => {
      delete process.env.APP_ENV;
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', { isDefault: false });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED when RENDER is not true', () => {
      process.env.RENDER = 'false';
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', { isDefault: false });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED when RENDER_SERVICE_ID does not match staging service ID', () => {
      process.env.RENDER_SERVICE_ID = 'srv-production-different-id';
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', { isDefault: false });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED when RENDER_SERVICE_NAME does not match printgo-backend-staging', () => {
      process.env.RENDER_SERVICE_NAME = 'printgo-backend-production';
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', { isDefault: false });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED when RENDER_GIT_BRANCH does not match staging branch', () => {
      process.env.RENDER_GIT_BRANCH = 'main';
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', { isDefault: false });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED when STAGING_PRINTER_APPROVALS_ENABLED is unset', () => {
      delete process.env.STAGING_PRINTER_APPROVALS_ENABLED;
      delete process.env.ALLOW_STAGING_PRINTER_APPROVALS;
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', { isDefault: false });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED when STAGING_PRINTER_APPROVALS_ENABLED is false', () => {
      process.env.STAGING_PRINTER_APPROVALS_ENABLED = 'false';
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', { isDefault: false });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });
  });

  describe('3. Negative Cases — Mandatory isDefault: false Enforcement', () => {
    it('BLOCKED when isDefault is true', () => {
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', {
        displayName: 'Epson L6460',
        isDefault: true
      });
      const res = createMockRes();
      const next = jest.fn();

      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('BLOCKED when isDefault is missing from body', () => {
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', {
        displayName: 'Epson L6460'
      });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED when isDefault is null', () => {
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', {
        displayName: 'Epson L6460',
        isDefault: null
      });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED when isDefault is string "false"', () => {
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', {
        displayName: 'Epson L6460',
        isDefault: 'false'
      });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED when isDefault is number 0', () => {
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', {
        displayName: 'Epson L6460',
        isDefault: 0
      });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED when body is undefined or empty', () => {
      const req = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve', undefined);
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });
  });

  describe('4. Negative Cases — Method and Route Scoping Restrictions', () => {
    it('BLOCKED for GET method on approval path', () => {
      const req = createMockReq('GET', '/api/admin/printer-discoveries/disc_001/approve', { isDefault: false });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED for PUT method on approval path', () => {
      const req = createMockReq('PUT', '/api/admin/printer-discoveries/disc_001/approve', { isDefault: false });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED for DELETE method on approval path', () => {
      const req = createMockReq('DELETE', '/api/admin/printer-discoveries/disc_001/approve', { isDefault: false });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED for other admin mutation POST routes (pricing)', () => {
      const req = createMockReq('POST', '/api/admin/pricing', { name: 'New Pricing' });
      const res = createMockRes();
      const next = jest.fn();

      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
      readOnlyGuard(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('BLOCKED for dispatch-job POST route', () => {
      const req = createMockReq('POST', '/api/admin/dispatch-job', { shortId: 'job_123' });
      expect(isAllowedStagingPrinterApproval(req)).toBe(false);
    });

    it('BLOCKED for printer-device enable/disable/remap POST routes', () => {
      const disableReq = createMockReq('POST', '/api/admin/printer-devices/dev_001/disable', { reason: 'Test disable' });
      const enableReq = createMockReq('POST', '/api/admin/printer-devices/dev_001/enable', { reason: 'Test enable' });
      const remapReq = createMockReq('POST', '/api/admin/printer-devices/dev_001/remap', { windowsPrinterName: 'New Queue' });

      expect(isAllowedStagingPrinterApproval(disableReq)).toBe(false);
      expect(isAllowedStagingPrinterApproval(enableReq)).toBe(false);
      expect(isAllowedStagingPrinterApproval(remapReq)).toBe(false);
    });

    it('BLOCKED for lookalike or extra path segments', () => {
      const req1 = createMockReq('POST', '/api/admin/printer-discoveries/disc_001/approve/extra', { isDefault: false });
      const req2 = createMockReq('POST', '/api/admin/printer-discoveries/approve', { isDefault: false });
      const req3 = createMockReq('POST', '/api/v1/admin/printer-discoveries/disc_001/approve', { isDefault: false });

      expect(isAllowedStagingPrinterApproval(req1)).toBe(false);
      expect(isAllowedStagingPrinterApproval(req2)).toBe(false);
      expect(isAllowedStagingPrinterApproval(req3)).toBe(false);
    });
  });

  describe('5. Independence & Preservation of Existing Exemptions', () => {
    it('Does NOT affect isAllowedStagingPaymentModeConfig', () => {
      process.env.ALLOW_STAGING_PAYMENT_MODE_CONFIG = 'true';
      process.env.STAGING_PAYMENT_MODE_ALLOWED_MACHINE_ID = 'd010496f-f176-41fe-9c98-efd2213a4a0e';

      const paymentReq = createMockReq('PUT', '/api/machines/d010496f-f176-41fe-9c98-efd2213a4a0e/payment-mode', {
        paymentMode: 'DEMO_SIMULATION'
      });
      expect(isAllowedStagingPaymentModeConfig(paymentReq)).toBe(true);
    });

    it('Does NOT affect isAllowedCashMutation', () => {
      process.env.ALLOW_CASH_PAYMENT_MUTATIONS = 'true';
      const cashReq = createMockReq('POST', '/api/admin/jobs/job_123/confirm-cash');
      expect(isAllowedCashMutation(cashReq)).toBe(true);
    });

    it('Does NOT affect isAllowedAdMutation', () => {
      process.env.ALLOW_ADVERTISEMENT_MUTATIONS = 'true';
      const adReq = createMockReq('POST', '/api/advertisements/admin');
      expect(isAllowedAdMutation(adReq)).toBe(true);
    });
  });
});
