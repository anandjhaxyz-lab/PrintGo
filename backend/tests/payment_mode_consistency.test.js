/**
 * PRINTGO — UNIFIED PAYMENT MODE CONSISTENCY & INTEGRITY TEST SUITE
 *
 * Validates:
 * 1. Default fallback to DEFAULT_PAYMENT_MODE ('CASH_AT_COUNTER') when paymentMode is NULL/undefined.
 * 2. Explicit database values (CASH_AT_COUNTER, DEMO_SIMULATION, CASHFREE_ONLINE) always take precedence.
 * 3. Parity between Admin API and Customer QR / Pricing APIs (no divergence on NULL).
 * 4. Customer QR session inheritance of resolved paymentMode.
 * 5. Job paymentMode inheritance from session and machine.
 * 6. Cashfree KYC verification protection and gating.
 * 7. Demo Payment Guard protection and gating.
 */

const { PAYMENT_MODES, DEFAULT_PAYMENT_MODE } = require('../src/constants/paymentModes');
const machinesService = require('../src/modules/machines/machines.service');
const machinesController = require('../src/modules/machines/machines.controller');
const prisma = require('../src/utils/prisma');

jest.mock('../src/utils/prisma', () => ({
  machine: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  },
  printerQr: {
    findUnique: jest.fn()
  },
  session: {
    findUnique: jest.fn(),
    create: jest.fn()
  },
  document: {
    create: jest.fn().mockResolvedValue({ id: 'doc-1', pages: 1 })
  },
  printJob: {
    create: jest.fn()
  },
  printPricingProfile: {
    findFirst: jest.fn()
  },
  auditLog: {
    create: jest.fn()
  },
  $transaction: jest.fn()
}));

jest.mock('../src/services/printerAvailability.service', () => ({
  ONLINE_HEARTBEAT_WINDOW_MS: 90000,
  computePrinterAvailability: jest.fn(() => ({
    isReady: true,
    agentOnline: true,
    status: 'ONLINE',
    statusMessage: 'Printer Ready'
  })),
  getMachineAvailability: jest.fn(() => ({
    isReady: true,
    agentOnline: true,
    status: 'ONLINE',
    statusMessage: 'Printer Ready'
  }))
}));

describe('PrintGo Unified Payment Mode Consistency Suite', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...origEnv };
  });

  afterAll(() => {
    process.env = { ...origEnv };
  });

  describe('Constant Invariants', () => {
    test('DEFAULT_PAYMENT_MODE is strictly CASH_AT_COUNTER', () => {
      expect(DEFAULT_PAYMENT_MODE).toBe('CASH_AT_COUNTER');
      expect(PAYMENT_MODES.CASH_AT_COUNTER).toBe('CASH_AT_COUNTER');
      expect(PAYMENT_MODES.DEMO_SIMULATION).toBe('DEMO_SIMULATION');
      expect(PAYMENT_MODES.CASHFREE_ONLINE).toBe('CASHFREE_ONLINE');
    });
  });

  describe('Machine Service & Controller Payment Mode Fallback', () => {
    test('getMachineById returns DEFAULT_PAYMENT_MODE when database paymentMode is null', async () => {
      prisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        name: 'Main Shop Printer',
        paymentMode: null,
        companyId: 'comp-1',
        status: 'ACTIVE'
      });

      const machine = await machinesService.getMachineById('mach-1', { role: 'SUPERADMIN' });
      expect(machine.paymentMode).toBe(DEFAULT_PAYMENT_MODE);
      expect(machine.paymentMode).toBe('CASH_AT_COUNTER');
    });

    test('getMachineById preserves explicit DEMO_SIMULATION from database', async () => {
      prisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        name: 'Main Shop Printer',
        paymentMode: 'DEMO_SIMULATION',
        companyId: 'comp-1',
        status: 'ACTIVE'
      });

      const machine = await machinesService.getMachineById('mach-1', { role: 'SUPERADMIN' });
      expect(machine.paymentMode).toBe('DEMO_SIMULATION');
    });

    test('getMachineById preserves explicit CASHFREE_ONLINE from database', async () => {
      prisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        name: 'Main Shop Printer',
        paymentMode: 'CASHFREE_ONLINE',
        companyId: 'comp-1',
        status: 'ACTIVE'
      });

      const machine = await machinesService.getMachineById('mach-1', { role: 'SUPERADMIN' });
      expect(machine.paymentMode).toBe('CASHFREE_ONLINE');
    });

    test('Admin Controller getPaymentMode reports DEFAULT_PAYMENT_MODE when DB is null', async () => {
      prisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        name: 'Main Shop Printer',
        paymentMode: null,
        companyId: 'comp-1',
        status: 'ACTIVE'
      });

      let resJson = null;
      const res = { json: (data) => { resJson = data; } };
      const req = { params: { id: 'mach-1' }, user: { role: 'SUPERADMIN' } };
      const next = jest.fn();

      await machinesController.getPaymentMode(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(resJson.success).toBe(true);
      expect(resJson.paymentMode).toBe('CASH_AT_COUNTER');
      expect(resJson.paymentMode).toBe(DEFAULT_PAYMENT_MODE);
    });
  });

  describe('Customer QR Metadata & Pricing Parity with Admin', () => {
    test('Public QR metadata returns DEFAULT_PAYMENT_MODE when machine paymentMode is null', async () => {
      const { getPublicPrinterQrInfo } = require('../src/services/printerQr.service');

      prisma.printerQr.findUnique.mockResolvedValue({
        id: 'qr-1',
        publicCode: 'pq_test_code',
        machineId: 'mach-1',
        status: 'ACTIVE',
        label: 'Front Counter',
        machine: {
          id: 'mach-1',
          name: 'Main Shop Printer',
          paymentMode: null,
          status: 'ACTIVE'
        }
      });

      const result = await getPublicPrinterQrInfo('pq_test_code');
      expect(result.success).toBe(true);
      expect(result.paymentMode).toBe('CASH_AT_COUNTER');
      expect(result.paymentMode).toBe(DEFAULT_PAYMENT_MODE);
    });

    test('Customer Pricing endpoint returns DEFAULT_PAYMENT_MODE when machine paymentMode is null', async () => {
      const { getPublicPricing } = require('../src/modules/auth/auth.controller');

      prisma.printerQr.findUnique.mockResolvedValue({
        machineId: 'mach-1'
      });
      prisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        paymentMode: null
      });

      let resStatus = null;
      let resJson = null;
      const res = {
        status(code) { resStatus = code; return this; },
        json(data) { resJson = data; return this; }
      };
      const req = { query: { publicCode: 'pq_test_code' } };
      const next = jest.fn();

      await getPublicPricing(req, res, next);
      expect(resStatus).toBe(200);
      expect(resJson.success).toBe(true);
      expect(resJson.paymentMode).toBe('CASH_AT_COUNTER');
      expect(resJson.paymentMode).toBe(DEFAULT_PAYMENT_MODE);
    });

    test('Customer Pricing endpoint reports DEMO_SIMULATION and enableDemoPayment=true when configured', async () => {
      const { getPublicPricing } = require('../src/modules/auth/auth.controller');

      process.env.APP_ENV = 'staging';
      process.env.ENABLE_DEMO_PAYMENT = 'true';
      process.env.RENDER = 'true';
      process.env.RENDER_SERVICE_ID = 'srv-dbqpapon74is73csbc80';
      process.env.RENDER_SERVICE_NAME = 'printgo-backend-staging';
      process.env.RENDER_GIT_BRANCH = 'feature/printgo-production-readiness';

      prisma.printerQr.findUnique.mockResolvedValue({ machineId: 'mach-1' });
      prisma.machine.findUnique.mockResolvedValue({ id: 'mach-1', paymentMode: 'DEMO_SIMULATION' });

      let resJson = null;
      const res = {
        status() { return this; },
        json(data) { resJson = data; }
      };
      const req = { query: { publicCode: 'pq_test_code' } };
      const next = jest.fn();

      await getPublicPricing(req, res, next);
      expect(resJson.paymentMode).toBe('DEMO_SIMULATION');
      expect(resJson.enableDemoPayment).toBe(true);
    });
  });

  describe('Session & Job Payment Mode Inheritance', () => {
    test('Job inherits paymentMode from Session when available', async () => {
      const { createJob } = require('../src/modules/jobs/jobs.service');

      prisma.session.findUnique.mockResolvedValue({
        id: 'sess-1',
        code: 'sess_abc',
        paymentMode: 'DEMO_SIMULATION'
      });

      prisma.printJob.create.mockImplementation(async ({ data }) => ({
        id: 'job-1',
        ...data
      }));

      const job = await createJob({
        jobData: { sessionId: 'sess_abc' },
        file: { pages: 1 },
        settings: { color: 'bw', duplex: 'single', copies: 1 },
        document: { id: 'doc-1' },
        machineId: 'mach-1'
      });

      expect(job.paymentMode).toBe('DEMO_SIMULATION');
    });

    test('Job falls back to DEFAULT_PAYMENT_MODE when session and machine paymentMode are null', async () => {
      const { createJob } = require('../src/modules/jobs/jobs.service');

      prisma.session.findUnique.mockResolvedValue({
        id: 'sess-1',
        code: 'sess_abc',
        paymentMode: null
      });
      prisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        paymentMode: null
      });

      prisma.printJob.create.mockImplementation(async ({ data }) => ({
        id: 'job-1',
        ...data
      }));

      const job = await createJob({
        jobData: { sessionId: 'sess_abc' },
        file: { pages: 1 },
        settings: { color: 'bw', duplex: 'single', copies: 1 },
        document: { id: 'doc-1' },
        machineId: 'mach-1'
      });

      expect(job.paymentMode).toBe('CASH_AT_COUNTER');
      expect(job.paymentMode).toBe(DEFAULT_PAYMENT_MODE);
    });
  });

  describe('Gateway Availability & KYC Gating', () => {
    test('Cashfree Online capability is false when KYC is unverified', () => {
      delete process.env.CASHFREE_KYC_VERIFIED;
      delete process.env.CASHFREE_MERCHANT_KYC_APPROVED;
      process.env.CASHFREE_APP_ID = 'valid_app_id';
      process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_valid_key';
      process.env.CASHFREE_ENV = 'sandbox';

      const capabilities = machinesService.getPaymentModeCapabilities();
      expect(capabilities.CASHFREE_ONLINE.available).toBe(false);
      expect(capabilities.CASHFREE_ONLINE.description).toContain('Merchant KYC verification is pending approval');
    });

    test('Updating machine to CASHFREE_ONLINE fails closed when KYC is unapproved', async () => {
      delete process.env.CASHFREE_KYC_VERIFIED;
      delete process.env.CASHFREE_MERCHANT_KYC_APPROVED;
      process.env.CASHFREE_APP_ID = 'valid_app_id';
      process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_valid_key';
      process.env.CASHFREE_ENV = 'sandbox';

      prisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        paymentMode: 'CASH_AT_COUNTER',
        companyId: 'comp-1'
      });

      await expect(
        machinesService.updateMachinePaymentMode('mach-1', 'CASHFREE_ONLINE', { role: 'SUPERADMIN' }, null)
      ).rejects.toThrow('Merchant KYC verification is pending approval with Cashfree.');
    });

    test('Updating machine to DEMO_SIMULATION fails closed outside authorized Staging environment', async () => {
      // Unset staging env
      delete process.env.APP_ENV;
      delete process.env.ENABLE_DEMO_PAYMENT;

      prisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        paymentMode: 'CASH_AT_COUNTER',
        companyId: 'comp-1'
      });

      await expect(
        machinesService.updateMachinePaymentMode('mach-1', 'DEMO_SIMULATION', { role: 'SUPERADMIN' }, null)
      ).rejects.toThrow('Demo Simulation is disabled');
    });
  });
});
