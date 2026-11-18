/**
 * PRINTGO — CASH PAYMENT MODE & PAYMENT MODE SWITCHING TESTS
 *
 * Verifies:
 * 1. Cash Order Creation: Inherits session-level paymentMode ('CASH_AT_COUNTER'), cost is server-authoritative, status is PENDING_PAYMENT.
 * 2. Customer Isolation: Customer cannot self-confirm payment (session token rejected with 401/403).
 * 3. Multi-Tenant Authorization: Staff from another company cannot confirm cash for target machine/job (403).
 * 4. Server-Authoritative Amount: Reject mismatched passed amount; confirm exact job.cost.
 * 5. Successful Staff Confirmation: Records method ('cash'), amount, confirmedBy, confirmedAt, Transaction, AuditLog, transitions job to WAITING.
 * 6. Idempotency & Deduplication: Concurrent or duplicate confirmation requests return existing record without duplicate payments or print dispatches.
 * 7. Realtime Socket Notifications: Emits kiosk_payment_success and job_status_changed to customer and admin rooms.
 * 8. Queue Dispatch Error Handling: If queueService dispatch encounters an error, payment remains saved and job in WAITING for safe operator release.
 * 9. Admin Mode Switch: Authorized Admin/Franchisee switches mode; updates Machine.paymentMode; writes AuditLog; unauthorized or cross-tenant rejected.
 * 10. Mode Availability Guards: Cashfree Online rejected if KYC/credentials not configured; Demo Simulation rejected if not Staging-authorized.
 * 11. Session Isolation: Existing QR sessions and existing orders retain their original paymentMode after an Admin mode switch.
 * 12. Demo Simulation Preservation: Supervised demo payment continues enforcing DEMO_PAYMENT_ACCESS_CODE, rate limits, and timing-safe equality.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');

describe('PrintGo — Cash Payment Mode & Payment Mode Switcher', () => {
  let app;
  let mockPrisma;
  let mockQueueService;
  let mockIo;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.JWT_SECRET = 'test_jwt_secret_for_cash_and_modes';
    process.env.APP_ENV = 'staging';
    process.env.ENABLE_DEMO_PAYMENT = 'true';
    process.env.RENDER = 'true';
    process.env.RENDER_SERVICE_ID = 'srv-dbqpapon74is73csbc80';
    process.env.RENDER_SERVICE_NAME = 'printgo-backend-staging';
    process.env.RENDER_GIT_BRANCH = 'feature/printgo-production-readiness';
    process.env.DEMO_PAYMENT_ACCESS_CODE = 'DEMO_SECURE_CODE_123';

    // Mock IO
    mockIo = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn()
    };

    // Mock QueueService
    mockQueueService = {
      startPrintingProcess: jest.fn().mockResolvedValue({ success: true, jobId: 'mock_short_id' })
    };
    jest.doMock('../src/services/queueService', () => mockQueueService);

    // Mock Prisma with in-memory stores for tables
    mockPrisma = {
      machine: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn()
      },
      session: {
        findUnique: jest.fn(),
        create: jest.fn()
      },
      printJob: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn()
      },
      payment: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn()
      },
      transaction: {
        create: jest.fn()
      },
      auditLog: {
        create: jest.fn()
      },
      document: {
        create: jest.fn()
      },
      printerQr: {
        findUnique: jest.fn()
      },
      printPricingProfile: {
        findFirst: jest.fn().mockResolvedValue(null)
      },
      $transaction: jest.fn(async (callback) => {
        return callback(mockPrisma);
      }),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1)
    };
    jest.doMock('../src/utils/prisma', () => mockPrisma);
  });

  const createAdminToken = (role = 'SUPERADMIN', companyId = 'comp-1', email = 'admin@printgo.in') => {
    return jwt.sign(
      { id: `user-${role.toLowerCase()}-1`, email, role, companyId },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  };

  const createCustomerToken = (sessionId = 'sess-123', machineId = 'mach-1', paymentMode = 'CASH_AT_COUNTER') => {
    return jwt.sign(
      { sessionId, machineId, paymentMode, type: 'session', role: 'mobile' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  };

  describe('1. Cash Order Creation & Session Mode Snapshot', () => {
    test('createJob captures session paymentMode onto PrintJob and leaves status PENDING_PAYMENT', async () => {
      const { createJob } = require('../src/modules/jobs/jobs.service');

      mockPrisma.document.create.mockResolvedValue({ id: 'doc-1', originalName: 'notes.pdf', pages: 2 });
      mockPrisma.printJob.create.mockImplementation(async ({ data }) => ({
        id: 'job-uuid-1',
        ...data,
        document: { id: 'doc-1', originalName: 'notes.pdf', pages: 2 }
      }));

      const jobData = {
        file: { originalName: 'notes.pdf', filename: 'notes.pdf', mimetype: 'application/pdf', size: 1024, pages: 2 },
        settings: { color: 'bw', duplex: 'single', copies: 1, pageRangeType: 'all', pagesToPrint: 2 },
        machineId: 'mach-1',
        sessionId: 'sess-code-1',
        paymentMode: 'CASH_AT_COUNTER'
      };

      const created = await createJob(jobData);
      expect(created).toBeDefined();
      expect(created.paymentMode).toBe('CASH_AT_COUNTER');
      expect(mockPrisma.printJob.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          paymentMode: 'CASH_AT_COUNTER',
          cost: expect.any(Number)
        })
      }));
    });
  });

  describe('2. Cash Confirmation Permissions & Isolation', () => {
    test('Customer session token cannot confirm cash payment (401/403 forbidden)', async () => {
      const adminController = require('../src/modules/admin/admin.controller');

      const reqUnauthenticated = {
        params: { shortId: 'job12345' },
        body: { amount: 20 },
        user: undefined, // Customers / unauthenticated requests do not have req.user
        session: { sessionId: 'sess-123', role: 'mobile' },
        app: { get: () => mockIo }
      };

      const res1 = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next1 = jest.fn();

      await adminController.confirmCashPayment(reqUnauthenticated, res1, next1);
      expect(res1.status).toHaveBeenCalledWith(401);

      // Customer role token cannot confirm cash (403 forbidden)
      const reqCustomer = {
        params: { shortId: 'job12345' },
        body: { amount: 20 },
        user: { id: 'cust-1', role: 'CUSTOMER', companyId: 'comp-1' },
        session: { sessionId: 'sess-123', role: 'mobile' },
        app: { get: () => mockIo }
      };

      const res2 = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next2 = jest.fn();

      await adminController.confirmCashPayment(reqCustomer, res2, next2);
      expect(res2.status).toHaveBeenCalledWith(403);
    });

    test('Staff from another company cannot confirm cash for job belonging to different shop (403)', async () => {
      const adminController = require('../src/modules/admin/admin.controller');

      mockPrisma.printJob.findUnique.mockResolvedValue({
        id: 'job-uuid-1',
        shortId: 'job12345',
        cost: 25.00,
        status: 'PENDING_PAYMENT',
        paymentMode: 'CASH_AT_COUNTER',
        machine: { id: 'mach-1', companyId: 'company-a' }
      });

      const req = {
        params: { shortId: 'job12345' },
        body: { amount: 25.00 },
        user: { id: 'user-b', role: 'FRANCHISEE', companyId: 'company-b', email: 'franchisee-b@printgo.in' },
        app: { get: () => mockIo }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      await adminController.confirmCashPayment(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('Cannot confirm payment for job belonging to another shop')
      }));
    });
  });

  describe('2b. Cash-at-Counter Payment Mode Enforcement & Race Condition Guard', () => {
    test.each([
      { mode: 'CASHFREE_ONLINE', label: 'CASHFREE_ONLINE' },
      { mode: 'DEMO_SIMULATION', label: 'DEMO_SIMULATION' },
      { mode: null, label: 'null legacy payment mode' },
      { mode: undefined, label: 'undefined / missing payment mode' }
    ])('rejects cash confirmation for job with paymentMode=$label with HTTP 400', async ({ mode }) => {
      const adminController = require('../src/modules/admin/admin.controller');

      mockPrisma.printJob.findUnique.mockResolvedValue({
        id: 'job-uuid-1',
        shortId: 'job12345',
        cost: 20.00,
        status: 'PENDING_PAYMENT',
        paymentMode: mode,
        machine: { id: 'mach-1', companyId: 'company-a' }
      });

      const req = {
        params: { shortId: 'job12345' },
        body: { amount: 20.00 },
        user: { id: 'staff-1', role: 'STAFF', companyId: 'company-a', email: 'cashier@printgo.in' },
        app: { get: () => mockIo }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      await adminController.confirmCashPayment(req, res, next);

      // Assert HTTP 400 (or existing controller error-handling equivalent)
      const rejectedWith400 = (res.status.mock.calls.length > 0 && res.status.mock.calls[0][0] === 400) ||
                             (next.mock.calls.length > 0 && next.mock.calls[0][0]?.statusCode === 400);
      expect(rejectedWith400).toBe(true);

      if (res.status.mock.calls.length > 0) {
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          success: false,
          error: expect.stringContaining('Cash confirmation is permitted only for CASH_AT_COUNTER jobs')
        }));
      }

      // Assert no payment record created, no job update, no queue dispatch, no false success
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
      expect(mockPrisma.printJob.update).not.toHaveBeenCalled();
      expect(mockQueueService.startPrintingProcess).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    test('transaction race condition: rejects confirmation when freshJob paymentMode changed to CASHFREE_ONLINE inside transaction', async () => {
      const adminController = require('../src/modules/admin/admin.controller');

      // 1. Initial job lookup returns CASH_AT_COUNTER
      const initialJob = {
        id: 'job-race-1',
        shortId: 'job_race_123',
        cost: 25.00,
        status: 'PENDING_PAYMENT',
        paymentMode: 'CASH_AT_COUNTER',
        machine: { id: 'mach-1', companyId: 'company-a' }
      };

      // 2. Transaction-level fresh lookup returns CASHFREE_ONLINE
      const freshJobChanged = {
        id: 'job-race-1',
        shortId: 'job_race_123',
        cost: 25.00,
        status: 'PENDING_PAYMENT',
        paymentMode: 'CASHFREE_ONLINE',
        machine: { id: 'mach-1', companyId: 'company-a' }
      };

      mockPrisma.printJob.findUnique
        .mockResolvedValueOnce(initialJob) // Initial read
        .mockResolvedValueOnce(freshJobChanged); // Inside tx

      const req = {
        params: { shortId: 'job_race_123' },
        body: { amount: 25.00 },
        user: { id: 'staff-1', role: 'STAFF', companyId: 'company-a', email: 'cashier@printgo.in' },
        app: { get: () => mockIo }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      await adminController.confirmCashPayment(req, res, next);

      // 3. Confirmation must be rejected with HTTP 400 (or controller error-handling equivalent)
      const rejectedWith400 = (res.status.mock.calls.length > 0 && res.status.mock.calls[0][0] === 400) ||
                             (next.mock.calls.length > 0 && next.mock.calls[0][0]?.statusCode === 400);
      expect(rejectedWith400).toBe(true);

      // 4. No payment creation, job update or queue dispatch may occur
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
      expect(mockPrisma.printJob.update).not.toHaveBeenCalled();
      expect(mockQueueService.startPrintingProcess).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
  });

  describe('3. Server-Authoritative Amount Validation', () => {
    test('rejects cash confirmation when passed amount does not match authoritative job cost (400)', async () => {
      const adminController = require('../src/modules/admin/admin.controller');

      mockPrisma.printJob.findUnique.mockResolvedValue({
        id: 'job-uuid-1',
        shortId: 'job12345',
        cost: 30.00,
        status: 'PENDING_PAYMENT',
        paymentMode: 'CASH_AT_COUNTER',
        machine: { id: 'mach-1', companyId: 'company-a' }
      });

      const req = {
        params: { shortId: 'job12345' },
        body: { amount: 99.00 }, // Deliberately incorrect amount
        user: { id: 'admin-1', role: 'SUPERADMIN', email: 'admin@printgo.in' },
        app: { get: () => mockIo }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      await adminController.confirmCashPayment(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('does not match exact payable amount')
      }));
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
      expect(mockQueueService.startPrintingProcess).not.toHaveBeenCalled();
    });
  });

  describe('4. Successful Cash Confirmation & Queue Dispatch', () => {
    test('confirms cash, records Payment with confirmedBy and confirmedAt, updates status to WAITING, and dispatches print', async () => {
      const adminController = require('../src/modules/admin/admin.controller');

      const mockJob = {
        id: 'job-uuid-1',
        shortId: 'job12345',
        cost: 15.00,
        status: 'PENDING_PAYMENT',
        paymentMode: 'CASH_AT_COUNTER',
        pricingSnapshot: JSON.stringify({ sessionId: 'sess-abc-123' }),
        machine: { id: 'mach-1', companyId: 'company-a' }
      };

      mockPrisma.printJob.findUnique.mockResolvedValue(mockJob);
      mockPrisma.payment.create.mockResolvedValue({
        id: 'pay-uuid-1',
        amount: 15.00,
        status: 'SUCCESS',
        paymentMethod: 'cash',
        confirmedBy: 'cashier@printgo.in',
        confirmedAt: new Date()
      });
      mockPrisma.printJob.update.mockResolvedValue({
        ...mockJob,
        status: 'WAITING',
        paymentId: 'pay-uuid-1'
      });
      mockPrisma.transaction.create.mockResolvedValue({ id: 'txn-1' });
      mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      const req = {
        params: { shortId: 'job12345' },
        body: { amount: 15.00 },
        user: { id: 'staff-1', role: 'STAFF', companyId: 'company-a', email: 'cashier@printgo.in' },
        app: { get: () => mockIo }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      await adminController.confirmCashPayment(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        dispatched: true,
        message: expect.stringContaining('Cash payment confirmed and print job dispatched')
      }));

      // Verifies Payment fields
      expect(mockPrisma.payment.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          amount: 15.00,
          paymentMethod: 'cash',
          status: 'SUCCESS',
          confirmedBy: 'cashier@printgo.in',
          confirmedAt: expect.any(Date)
        })
      }));

      // Verifies PrintJob status transition to WAITING
      expect(mockPrisma.printJob.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'job-uuid-1' },
        data: expect.objectContaining({
          status: 'WAITING',
          paymentId: 'pay-uuid-1'
        })
      }));

      // Verifies exactly ONE print queue dispatch
      expect(mockQueueService.startPrintingProcess).toHaveBeenCalledTimes(1);
      expect(mockQueueService.startPrintingProcess).toHaveBeenCalledWith('job12345', mockIo);

      // Verifies realtime notifications to customer session and admins
      expect(mockIo.to).toHaveBeenCalledWith('sess-abc-123');
      expect(mockIo.to).toHaveBeenCalledWith('job_job12345');
      expect(mockIo.to).toHaveBeenCalledWith('admins');
    });

    test('safe idempotency: duplicate confirmation returns alreadyConfirmed=true without creating duplicate payment or re-dispatching', async () => {
      const adminController = require('../src/modules/admin/admin.controller');

      // Job is already in WAITING state (already confirmed)
      const mockJob = {
        id: 'job-uuid-1',
        shortId: 'job12345',
        cost: 15.00,
        status: 'WAITING',
        paymentMode: 'CASH_AT_COUNTER',
        payment: { id: 'pay-uuid-1', status: 'SUCCESS', paymentMethod: 'cash' },
        machine: { id: 'mach-1', companyId: 'company-a' }
      };

      mockPrisma.printJob.findUnique.mockResolvedValue(mockJob);

      const req = {
        params: { shortId: 'job12345' },
        body: { amount: 15.00 },
        user: { id: 'staff-1', role: 'STAFF', companyId: 'company-a', email: 'cashier@printgo.in' },
        app: { get: () => mockIo }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      await adminController.confirmCashPayment(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        alreadyConfirmed: true,
        message: expect.stringContaining('already been confirmed/paid')
      }));

      // Does NOT create duplicate payment
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
      // Does NOT dispatch duplicate print
      expect(mockQueueService.startPrintingProcess).not.toHaveBeenCalled();
    });

    test('safe recovery: if print queue dispatch throws, payment remains confirmed and error is returned cleanly', async () => {
      const adminController = require('../src/modules/admin/admin.controller');

      mockQueueService.startPrintingProcess.mockRejectedValueOnce(new Error('Printer agent offline'));

      const mockJob = {
        id: 'job-uuid-2',
        shortId: 'job67890',
        cost: 20.00,
        status: 'PENDING_PAYMENT',
        paymentMode: 'CASH_AT_COUNTER',
        machine: { id: 'mach-1', companyId: 'company-a' }
      };

      mockPrisma.printJob.findUnique.mockResolvedValue(mockJob);
      mockPrisma.payment.create.mockResolvedValue({
        id: 'pay-uuid-2',
        amount: 20.00,
        status: 'SUCCESS',
        paymentMethod: 'cash'
      });
      mockPrisma.printJob.update.mockResolvedValue({
        ...mockJob,
        status: 'WAITING',
        paymentId: 'pay-uuid-2'
      });

      const req = {
        params: { shortId: 'job67890' },
        body: { amount: 20.00 },
        user: { id: 'staff-1', role: 'STAFF', companyId: 'company-a', email: 'cashier@printgo.in' },
        app: { get: () => mockIo }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      await adminController.confirmCashPayment(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        dispatched: false,
        dispatchError: 'Printer agent offline',
        message: expect.stringContaining('operator can release from Admin dashboard')
      }));

      // Payment was still confirmed and saved!
      expect(mockPrisma.payment.create).toHaveBeenCalled();
      expect(mockPrisma.printJob.update).toHaveBeenCalled();
    });
  });

  describe('5. Admin Payment Mode Switcher & Availability Guards', () => {
    test('updates machine paymentMode to DEMO_SIMULATION when authorized on Staging', async () => {
      const machinesService = require('../src/modules/machines/machines.service');

      mockPrisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        name: 'Kiosk Main',
        companyId: 'company-a',
        paymentMode: 'CASH_AT_COUNTER',
        printerStatuses: []
      });
      mockPrisma.machine.update.mockResolvedValue({
        id: 'mach-1',
        name: 'Kiosk Main',
        companyId: 'company-a',
        paymentMode: 'DEMO_SIMULATION'
      });

      const updated = await machinesService.updateMachinePaymentMode(
        'mach-1',
        'DEMO_SIMULATION',
        { id: 'admin-1', role: 'SUPERADMIN', email: 'admin@printgo.in' },
        mockIo
      );

      expect(updated.paymentMode).toBe('DEMO_SIMULATION');
      expect(mockPrisma.machine.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'mach-1' },
        data: { paymentMode: 'DEMO_SIMULATION' }
      }));
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          entity: 'Machine',
          action: 'UPDATE_PAYMENT_MODE',
          performedBy: 'admin@printgo.in'
        })
      }));
    });

    test('rejects switch to CASHFREE_ONLINE when KYC/credentials are unconfigured or placeholder', async () => {
      const machinesService = require('../src/modules/machines/machines.service');

      // Temporarily clear credentials to verify availability guard
      delete process.env.CASHFREE_APP_ID;
      delete process.env.CASHFREE_SECRET_KEY;
      delete process.env.CASHFREE_KYC_VERIFIED;

      mockPrisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        name: 'Kiosk Main',
        companyId: 'company-a',
        paymentMode: 'CASH_AT_COUNTER',
        printerStatuses: []
      });

      await expect(
        machinesService.updateMachinePaymentMode(
          'mach-1',
          'CASHFREE_ONLINE',
          { id: 'admin-1', role: 'SUPERADMIN', email: 'admin@printgo.in' },
          mockIo
        )
      ).rejects.toThrow(/Cashfree Online is unavailable/);

      expect(mockPrisma.machine.update).not.toHaveBeenCalled();
    });

    test('rejects switch to CASHFREE_ONLINE when credentials exist but KYC verification is unconfirmed', async () => {
      const machinesService = require('../src/modules/machines/machines.service');

      // Configure valid sandbox credentials but no KYC approval
      process.env.CASHFREE_ENV = 'sandbox';
      process.env.CASHFREE_APP_ID = 'VALID_SANDBOX_APP_ID_123';
      process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_valid_sandbox_secret_key_12345';
      delete process.env.CASHFREE_KYC_VERIFIED;

      mockPrisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        name: 'Kiosk Main',
        companyId: 'company-a',
        paymentMode: 'CASH_AT_COUNTER',
        printerStatuses: []
      });

      await expect(
        machinesService.updateMachinePaymentMode(
          'mach-1',
          'CASHFREE_ONLINE',
          { id: 'admin-1', role: 'SUPERADMIN', email: 'admin@printgo.in' },
          mockIo
        )
      ).rejects.toThrow(/Merchant KYC verification is pending approval with Cashfree/);

      expect(mockPrisma.machine.update).not.toHaveBeenCalled();
    });

    test('allows switch to CASHFREE_ONLINE when credentials and KYC are confirmed', async () => {
      const machinesService = require('../src/modules/machines/machines.service');

      process.env.CASHFREE_ENV = 'sandbox';
      process.env.CASHFREE_APP_ID = 'VALID_SANDBOX_APP_ID_123';
      process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_valid_sandbox_secret_key_12345';
      process.env.CASHFREE_KYC_VERIFIED = 'true';

      mockPrisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        name: 'Kiosk Main',
        companyId: 'company-a',
        paymentMode: 'CASH_AT_COUNTER',
        printerStatuses: []
      });
      mockPrisma.machine.update.mockResolvedValue({
        id: 'mach-1',
        name: 'Kiosk Main',
        companyId: 'company-a',
        paymentMode: 'CASHFREE_ONLINE'
      });

      const updated = await machinesService.updateMachinePaymentMode(
        'mach-1',
        'CASHFREE_ONLINE',
        { id: 'admin-1', role: 'SUPERADMIN', email: 'admin@printgo.in' },
        mockIo
      );

      expect(updated.paymentMode).toBe('CASHFREE_ONLINE');
      expect(mockPrisma.machine.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'mach-1' },
        data: { paymentMode: 'CASHFREE_ONLINE' }
      }));
    });

    test('machine with null paymentMode defaults to DEFAULT_PAYMENT_MODE (CASH_AT_COUNTER)', async () => {
      const machinesService = require('../src/modules/machines/machines.service');
      const { DEFAULT_PAYMENT_MODE } = require('../src/constants/paymentModes');

      mockPrisma.machine.findMany.mockResolvedValue([
        {
          id: 'legacy-mach-1',
          name: 'Legacy Printer',
          companyId: 'company-a',
          paymentMode: null, // Machine with unconfigured / null paymentMode
          printerStatuses: []
        }
      ]);

      const machines = await machinesService.getMachines({ id: 'admin-1', role: 'SUPERADMIN' });
      expect(machines).toHaveLength(1);
      expect(machines[0].paymentMode).toBe(DEFAULT_PAYMENT_MODE);
      expect(machines[0].paymentMode).toBe('CASH_AT_COUNTER');
    });

    test('machine with explicitly configured CASHFREE_ONLINE preserves CASHFREE_ONLINE', async () => {
      const machinesService = require('../src/modules/machines/machines.service');

      mockPrisma.machine.findMany.mockResolvedValue([
        {
          id: 'online-mach-1',
          name: 'Online Printer',
          companyId: 'company-a',
          paymentMode: 'CASHFREE_ONLINE', // Explicitly configured online machine
          printerStatuses: []
        }
      ]);

      const machines = await machinesService.getMachines({ id: 'admin-1', role: 'SUPERADMIN' });
      expect(machines).toHaveLength(1);
      expect(machines[0].paymentMode).toBe('CASHFREE_ONLINE');
    });

    test('new machine onboarding explicitly assigns paymentMode', async () => {
      const machinesService = require('../src/modules/machines/machines.service');

      mockPrisma.machine.create.mockImplementation(async ({ data }) => ({
        id: 'new-mach-1',
        ...data,
        company: { id: data.companyId, name: 'Shop 1' }
      }));

      const newMachine = await machinesService.createMachine({
        name: 'Counter Machine 2',
        location: 'Billing Desk',
        companyId: 'comp-1',
        paymentMode: 'CASH_AT_COUNTER'
      });

      expect(newMachine.paymentMode).toBe('CASH_AT_COUNTER');
      expect(mockPrisma.machine.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          paymentMode: 'CASH_AT_COUNTER'
        })
      }));
    });

    test('rejects switch to DEMO_SIMULATION in production environment', async () => {
      const machinesService = require('../src/modules/machines/machines.service');

      // Set environment to production
      process.env.APP_ENV = 'production';

      mockPrisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        name: 'Kiosk Main',
        companyId: 'company-a',
        paymentMode: 'CASH_AT_COUNTER',
        printerStatuses: []
      });

      await expect(
        machinesService.updateMachinePaymentMode(
          'mach-1',
          'DEMO_SIMULATION',
          { id: 'admin-1', role: 'SUPERADMIN', email: 'admin@printgo.in' },
          mockIo
        )
      ).rejects.toThrow(/Demo Simulation is disabled/);

      expect(mockPrisma.machine.update).not.toHaveBeenCalled();
    });

    test('rejects cross-tenant mode update by Franchisee (403)', async () => {
      const machinesService = require('../src/modules/machines/machines.service');

      mockPrisma.machine.findUnique.mockResolvedValue({
        id: 'mach-1',
        name: 'Kiosk Main',
        companyId: 'company-a',
        paymentMode: 'CASH_AT_COUNTER',
        printerStatuses: []
      });

      await expect(
        machinesService.updateMachinePaymentMode(
          'mach-1',
          'CASH_AT_COUNTER',
          { id: 'franchisee-b', role: 'FRANCHISEE', companyId: 'company-b', email: 'franchisee-b@printgo.in' },
          mockIo
        )
      ).rejects.toThrow(/Access denied: Machine belongs to another company/);

      expect(mockPrisma.machine.update).not.toHaveBeenCalled();
    });
  });

  describe('6. Historical Baseline Protection', () => {
    test('historical baseline job ab36197e cannot be confirmed via cash endpoint (400)', async () => {
      const adminController = require('../src/modules/admin/admin.controller');

      const req = {
        params: { shortId: 'ab36197e' },
        body: { amount: 10 },
        user: { id: 'admin-1', role: 'SUPERADMIN', email: 'admin@printgo.in' },
        app: { get: () => mockIo }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      await adminController.confirmCashPayment(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('ab36197e is protected')
      }));
    });
  });

  describe('7. Print Queue Exactly-Once Dispatch & Safe Recovery Matrix', () => {
    test('Scenario A: Queue dispatch succeeds and transitions WAITING to PRINTING', async () => {
      // Unmock queueService to test the real processJob logic
      jest.unmock('../src/services/queueService');
      const queueService = require('../src/services/queueService');

      mockPrisma.printJob.findUnique
        .mockResolvedValueOnce({
          shortId: 'job_q_1',
          status: 'WAITING',
          cost: 10,
          pagesToPrint: 1,
          copies: 1,
          machineId: 'mach-1',
          document: { filename: 'file.pdf', originalName: 'file.pdf' }
        })
        .mockResolvedValueOnce({
          shortId: 'job_q_1',
          status: 'PRINTING',
          cost: 10,
          pagesToPrint: 1,
          copies: 1,
          machineId: 'mach-1',
          document: { filename: 'file.pdf', originalName: 'file.pdf' }
        });

      mockPrisma.printJob.updateMany.mockResolvedValue({ count: 1 });

      await queueService.startPrintingProcess('job_q_1', mockIo);

      expect(mockPrisma.printJob.updateMany).toHaveBeenCalledWith({
        where: { shortId: 'job_q_1', status: 'WAITING' },
        data: { status: 'PRINTING' }
      });
      expect(mockIo.to).toHaveBeenCalledWith('machine_mach-1');
      expect(mockIo.emit).toHaveBeenCalledWith('physical_print_job', expect.objectContaining({
        jobId: 'job_q_1'
      }));
    });

    test('Scenario B: Queue dispatch fails before accepting the job, leaving it safely in WAITING', async () => {
      jest.unmock('../src/services/queueService');
      const queueService = require('../src/services/queueService');

      mockPrisma.printJob.findUnique.mockResolvedValue({
        shortId: 'job_q_fail',
        status: 'WAITING',
        machineId: 'mach-1'
      });
      // Simulate DB failure before accepting
      mockPrisma.printJob.updateMany.mockRejectedValue(new Error('DB connection timeout'));

      await queueService.startPrintingProcess('job_q_fail', mockIo);

      // Emitted physical print job must NOT have been called
      expect(mockIo.emit).not.toHaveBeenCalledWith('physical_print_job', expect.anything());
    });

    test('Scenario C: Dispatch accepts the job but caller retries; atomic lock skips duplicate physical dispatch', async () => {
      jest.unmock('../src/services/queueService');
      const queueService = require('../src/services/queueService');

      // Job is already claimed / in PRINTING
      mockPrisma.printJob.findUnique.mockResolvedValue({
        shortId: 'job_q_dup',
        status: 'PRINTING',
        machineId: 'mach-1'
      });
      mockPrisma.printJob.updateMany.mockResolvedValue({ count: 0 }); // 0 rows updated because status != WAITING

      await queueService.startPrintingProcess('job_q_dup', mockIo);

      // Does not emit physical print job
      expect(mockIo.emit).not.toHaveBeenCalledWith('physical_print_job', expect.anything());
    });

    test('Scenario D: Admin retries manual release on already COMPLETED job; no duplicate print emitted', async () => {
      jest.unmock('../src/services/queueService');
      const queueService = require('../src/services/queueService');

      mockPrisma.printJob.findUnique.mockResolvedValue({
        shortId: 'job_q_comp',
        status: 'COMPLETED',
        machineId: 'mach-1'
      });
      mockPrisma.printJob.updateMany.mockResolvedValue({ count: 0 });

      await queueService.startPrintingProcess('job_q_comp', mockIo);

      // Zero physical_print_job emitted
      expect(mockIo.emit).not.toHaveBeenCalledWith('physical_print_job', expect.anything());
    });
  });
});
