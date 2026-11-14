/**
 * p1_h01_job_session_ownership.test.js
 *
 * Targeted tests for H-01: Fail-Closed Job Session Ownership Hardening.
 * Tests cover both the access-check function and actual controller handler execution.
 */

'use strict';

jest.mock('../src/utils/prisma', () => {
  return {
    printJob: {
      findUnique: jest.fn(),
      update: jest.fn()
    },
    payment: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn()
    },
    transaction: {
      create: jest.fn()
    },
    $transaction: jest.fn()
  };
});

jest.mock('../src/modules/payments/payments.service', () => ({
  createOrder: jest.fn(),
  verifyPayment: jest.fn(),
  refundPayment: jest.fn(),
  resolvePrintJobForPayment: jest.fn()
}));

jest.mock('../src/services/queueService', () => ({
  startPrintingProcess: jest.fn()
}));

jest.mock('../src/services/cashfreeGateway.adapter', () => ({
  verifyWebhookSignature: jest.fn()
}));

const prisma = require('../src/utils/prisma');
const paymentsService = require('../src/modules/payments/payments.service');
const paymentsController = require('../src/modules/payments/payments.controller');
const { checkJobAccess, extractJobSessionId } = paymentsController;

describe('H-01: Fail-Closed Job Session Ownership', () => {
  const MACHINE_ID = 'machine-eps-01';
  const VALID_SESSION_ID = 'sess-valid-123';
  const OTHER_SESSION_ID = 'sess-attacker-999';

  const makeJobWithSession = (overrides = {}) => ({
    id: 'job-1',
    shortId: 'JOB001',
    status: 'PENDING_PAYMENT',
    cost: 20,
    machineId: MACHINE_ID,
    machine: { id: MACHINE_ID, companyId: 'comp-1' },
    pricingSnapshot: JSON.stringify({
      cost: 20,
      sessionId: VALID_SESSION_ID
    }),
    ...overrides
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Section 1: checkJobAccess Unit Matrix
  // =========================================================================

  describe('checkJobAccess function behavior', () => {
    test('1. Matching job and request session IDs -> allowed (returns null)', () => {
      const job = makeJobWithSession();
      const req = {
        session: {
          machineId: MACHINE_ID,
          sessionId: VALID_SESSION_ID
        }
      };

      const result = checkJobAccess(req, job);
      expect(result).toBeNull();
    });

    test('2. Mismatched session IDs -> 403 denied', () => {
      const job = makeJobWithSession();
      const req = {
        session: {
          machineId: MACHINE_ID,
          sessionId: OTHER_SESSION_ID
        }
      };

      const result = checkJobAccess(req, job);
      expect(result).not.toBeNull();
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/does not own this job/i);
    });

    test('3. Missing pricingSnapshot -> 403 denied for kiosk request (fail-closed)', () => {
      const job = makeJobWithSession({ pricingSnapshot: null });
      const req = {
        session: {
          machineId: MACHINE_ID,
          sessionId: VALID_SESSION_ID
        }
      };

      const result = checkJobAccess(req, job);
      expect(result).not.toBeNull();
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/no bound session/i);
    });

    test('4. pricingSnapshot without sessionId -> 403 denied for kiosk request (fail-closed)', () => {
      const job = makeJobWithSession({
        pricingSnapshot: JSON.stringify({ cost: 20 }) // No sessionId key
      });
      const req = {
        session: {
          machineId: MACHINE_ID,
          sessionId: VALID_SESSION_ID
        }
      };

      const result = checkJobAccess(req, job);
      expect(result).not.toBeNull();
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/no bound session/i);
    });

    test('5. Missing request session ID -> 403 denied for kiosk request (fail-closed)', () => {
      const job = makeJobWithSession();
      const req = {
        session: {
          machineId: MACHINE_ID,
          sessionId: null // Missing in request
        }
      };

      const result = checkJobAccess(req, job);
      expect(result).not.toBeNull();
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/no active session/i);
    });

    test('6. Valid authorized SUPERADMIN request -> allowed (even if job has no session)', () => {
      const job = makeJobWithSession({ pricingSnapshot: null });
      const req = {
        user: {
          id: 'admin-1',
          role: 'SUPERADMIN',
          companyId: 'any-company'
        }
      };

      const result = checkJobAccess(req, job);
      expect(result).toBeNull();
    });

    test('7. Valid authorized company admin request -> allowed for own company', () => {
      const job = makeJobWithSession();
      const req = {
        user: {
          id: 'admin-franchisee',
          role: 'FRANCHISEE',
          companyId: 'comp-1'
        }
      };

      const result = checkJobAccess(req, job);
      expect(result).toBeNull();
    });

    test('8. Company admin request for different company job -> 403 denied', () => {
      const job = makeJobWithSession();
      const req = {
        user: {
          id: 'admin-wrong-comp',
          role: 'FRANCHISEE',
          companyId: 'comp-OTHER'
        }
      };

      const result = checkJobAccess(req, job);
      expect(result).not.toBeNull();
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/another company/i);
    });

    test('9. Unauthorized request without session or user -> 401 denied', () => {
      const job = makeJobWithSession();
      const req = {}; // No session, no user

      const result = checkJobAccess(req, job);
      expect(result).not.toBeNull();
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/Authentication required/i);
    });

    test('10. Machine ID mismatch between session and job -> 403 denied', () => {
      const job = makeJobWithSession();
      const req = {
        session: {
          machineId: 'machine-OTHER',
          sessionId: VALID_SESSION_ID
        }
      };

      const result = checkJobAccess(req, job);
      expect(result).not.toBeNull();
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/does not own this machine job/i);
    });
  });

  // =========================================================================
  // Section 2: Controller Execution Path (createCashfreeOrder)
  // =========================================================================

  describe('createCashfreeOrder controller integration with checkJobAccess', () => {
    const mockResponse = () => {
      const res = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res;
    };

    test('Controller blocks kiosk request when job pricingSnapshot is missing', async () => {
      const job = makeJobWithSession({ pricingSnapshot: null });
      prisma.printJob.findUnique.mockResolvedValue(job);

      const req = {
        params: { id: 'JOB001' },
        session: {
          machineId: MACHINE_ID,
          sessionId: VALID_SESSION_ID
        },
        body: {}
      };
      const res = mockResponse();
      const next = jest.fn();

      await paymentsController.createCashfreeOrder(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringMatching(/no bound session/i)
        })
      );
      expect(paymentsService.createOrder).not.toHaveBeenCalled();
    });

    test('Controller allows kiosk request when session IDs match exactly', async () => {
      const job = makeJobWithSession();
      prisma.printJob.findUnique.mockResolvedValue(job);
      paymentsService.createOrder.mockResolvedValue({
        paymentSessionId: 'cf-session-xyz',
        orderId: 'order_JOB001_att1'
      });

      const req = {
        params: { id: 'JOB001' },
        session: {
          machineId: MACHINE_ID,
          sessionId: VALID_SESSION_ID
        },
        body: { returnUrl: 'http://localhost:5173/status' }
      };
      const res = mockResponse();
      const next = jest.fn();

      await paymentsController.createCashfreeOrder(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          paymentSessionId: 'cf-session-xyz',
          orderId: 'order_JOB001_att1'
        })
      );
      expect(paymentsService.createOrder).toHaveBeenCalledWith(
        'JOB001',
        expect.objectContaining({ sessionId: VALID_SESSION_ID })
      );
    });

    test('Controller blocks kiosk request when session ID is mismatched', async () => {
      const job = makeJobWithSession();
      prisma.printJob.findUnique.mockResolvedValue(job);

      const req = {
        params: { id: 'JOB001' },
        session: {
          machineId: MACHINE_ID,
          sessionId: OTHER_SESSION_ID
        },
        body: {}
      };
      const res = mockResponse();
      const next = jest.fn();

      await paymentsController.createCashfreeOrder(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringMatching(/does not own this job/i)
        })
      );
      expect(paymentsService.createOrder).not.toHaveBeenCalled();
    });
  });
});
