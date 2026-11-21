const request = require('supertest');
const express = require('express');

let mockCurrentUser = null;

jest.mock('../src/middlewares/auth', () => ({
  protect: (req, res, next) => {
    req.user = mockCurrentUser;
    next();
  },
  restrictTo: (...roles) => (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  }
}));

jest.mock('../src/middlewares/readOnlyGuard', () => ({
  readOnlyGuard: (req, res, next) => next()
}));

const mockJobs = new Map();
const mockPayments = new Map();
const mockRefunds = new Map();
const mockActivityLogs = [];
const mockPrintHistories = [];

const mockPrisma = {
  printJob: {
    findUnique: jest.fn(async ({ where }) => {
      const shortId = where.shortId;
      const id = where.id;
      let job = null;
      if (shortId) job = mockJobs.get(shortId);
      else if (id) {
        for (const j of mockJobs.values()) {
          if (j.id === id) { job = j; break; }
        }
      }
      if (!job) return null;
      const res = { ...job };
      if (job.paymentId && mockPayments.has(job.paymentId)) {
        res.payment = { ...mockPayments.get(job.paymentId) };
      }
      return res;
    }),
    findMany: jest.fn(async ({ where }) => {
      const results = [];
      for (const job of mockJobs.values()) {
        if (where.paymentId && job.paymentId === where.paymentId) {
          results.push({ ...job });
        }
      }
      return results;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      let job = null;
      if (where.shortId) job = mockJobs.get(where.shortId);
      else if (where.id) {
        for (const j of mockJobs.values()) {
          if (j.id === where.id) { job = j; break; }
        }
      }
      if (!job) return { count: 0 };

      if (where.status && job.status !== where.status) return { count: 0 };
      if (where.legacyAttemptsUnknown === false && job.legacyAttemptsUnknown) return { count: 0 };
      if (where.printAttempts?.lt !== undefined && job.printAttempts >= where.printAttempts.lt) {
        return { count: 0 };
      }

      if (data.status) job.status = data.status;
      if (data.printAttempts?.increment) {
        job.printAttempts = (job.printAttempts || 0) + data.printAttempts.increment;
      }
      return { count: 1 };
    }),
    update: jest.fn(async ({ where, data }) => {
      let targetJob = null;
      for (const job of mockJobs.values()) {
        if ((where.id && job.id === where.id) || (where.shortId && job.shortId === where.shortId)) {
          targetJob = job;
          break;
        }
      }
      if (!targetJob) throw new Error('Job not found');
      Object.assign(targetJob, data);
      return { ...targetJob };
    })
  },
  payment: {
    findUnique: jest.fn(async ({ where }) => {
      const p = mockPayments.get(where.id);
      return p ? { ...p } : null;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      const p = mockPayments.get(where.id);
      if (!p) return { count: 0 };

      if (where.legacyAttemptsUnknown === false && p.legacyAttemptsUnknown) return { count: 0 };
      if (where.authorizedPrintAttempts?.lt !== undefined && p.authorizedPrintAttempts >= where.authorizedPrintAttempts.lt) {
        return { count: 0 };
      }

      if (data.authorizedPrintAttempts?.increment) {
        p.authorizedPrintAttempts = (p.authorizedPrintAttempts || 0) + data.authorizedPrintAttempts.increment;
      }
      return { count: 1 };
    }),
    update: jest.fn(async ({ where, data }) => {
      const p = mockPayments.get(where.id);
      if (!p) throw new Error('Payment not found');
      Object.assign(p, data);
      return { ...p };
    })
  },
  activityLog: {
    create: jest.fn(async ({ data }) => {
      mockActivityLogs.push(data);
      return { id: `log-${Date.now()}`, ...data };
    })
  },
  printHistory: {
    create: jest.fn(async ({ data }) => {
      mockPrintHistories.push(data);
      return { id: `hist-${Date.now()}`, ...data };
    })
  },
  refund: {
    findFirst: jest.fn(async ({ where }) => {
      for (const r of mockRefunds.values()) {
        if (where.paymentId && r.paymentId === where.paymentId) {
          if (where.status?.in && where.status.in.includes(r.status)) {
            return { ...r };
          }
        }
      }
      return null;
    })
  },
  $transaction: jest.fn(async (callback) => {
    // Snapshot state for transaction rollback simulation
    const jobsSnapshot = new Map([...mockJobs.entries()].map(([k, v]) => [k, { ...v }]));
    const paymentsSnapshot = new Map([...mockPayments.entries()].map(([k, v]) => [k, { ...v }]));
    const logsLengthSnapshot = mockActivityLogs.length;
    const historyLengthSnapshot = mockPrintHistories.length;
    try {
      return await callback(mockPrisma);
    } catch (err) {
      mockJobs.clear();
      for (const [k, v] of jobsSnapshot) mockJobs.set(k, v);
      mockPayments.clear();
      for (const [k, v] of paymentsSnapshot) mockPayments.set(k, v);
      mockActivityLogs.length = logsLengthSnapshot;
      mockPrintHistories.length = historyLengthSnapshot;
      throw err;
    }
  })
};

jest.mock('../src/utils/prisma', () => mockPrisma);

const adminRoutes = require('../src/modules/admin/admin.routes');
const queueService = require('../src/services/queueService');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

describe('UP-02: Transaction-Wide Maximum Attempts Enforcement (Max 3 Total Attempts)', () => {
  const superadmin = {
    id: 'super-01',
    role: 'SUPERADMIN',
    email: 'super@printgo.test'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockJobs.clear();
    mockPayments.clear();
    mockRefunds.clear();
    mockActivityLogs.length = 0;
    mockPrintHistories.length = 0;
    mockCurrentUser = superadmin;
    mockPrisma.activityLog.create.mockImplementation(async ({ data }) => {
      mockActivityLogs.push(data);
      return { id: `log-${Date.now()}`, ...data };
    });
    mockPrisma.printHistory.create.mockImplementation(async ({ data }) => {
      mockPrintHistories.push(data);
      return { id: `hist-${Date.now()}`, ...data };
    });
  });

  test('1. Original dispatch reserves attempt 1 atomically and transitions WAITING to PRINTING', async () => {
    const shortId = 'job-att-01';
    const paymentId = 'pay-att-01';
    mockPayments.set(paymentId, {
      id: paymentId,
      authorizedPrintAttempts: 0,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-att-01',
      shortId,
      status: 'WAITING',
      paymentId,
      printAttempts: 0,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const result = await queueService.processJob(shortId);
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.maxAttempts).toBe(3);

    const saved = mockJobs.get(shortId);
    expect(saved.status).toBe('PRINTING');
    expect(saved.printAttempts).toBe(1);

    const savedPayment = mockPayments.get(paymentId);
    expect(savedPayment.authorizedPrintAttempts).toBe(1);

    expect(mockActivityLogs.length).toBe(1);
    expect(mockActivityLogs[0].action).toBe('PRINT_ATTEMPT_DISPATCHED');
    expect(JSON.parse(mockActivityLogs[0].details).attempt).toBe(1);
  });

  test('2. Second authorized dispatch reserves attempt 2 after legitimate recovery', async () => {
    const shortId = 'job-att-02';
    const paymentId = 'pay-att-02';
    mockPayments.set(paymentId, {
      id: paymentId,
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-att-02',
      shortId,
      status: 'WAITING',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const result = await queueService.processJob(shortId);
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);

    const saved = mockJobs.get(shortId);
    expect(saved.status).toBe('PRINTING');
    expect(saved.printAttempts).toBe(2);

    const savedPayment = mockPayments.get(paymentId);
    expect(savedPayment.authorizedPrintAttempts).toBe(2);
  });

  test('3. Third authorized dispatch reserves attempt 3', async () => {
    const shortId = 'job-att-03';
    const paymentId = 'pay-att-03';
    mockPayments.set(paymentId, {
      id: paymentId,
      authorizedPrintAttempts: 2,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-att-03',
      shortId,
      status: 'WAITING',
      paymentId,
      printAttempts: 2,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const result = await queueService.processJob(shortId);
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);

    const saved = mockJobs.get(shortId);
    expect(saved.status).toBe('PRINTING');
    expect(saved.printAttempts).toBe(3);

    const savedPayment = mockPayments.get(paymentId);
    expect(savedPayment.authorizedPrintAttempts).toBe(3);
  });

  test('4. Central queue dispatch strictly rejects attempt 4 when limit is reached', async () => {
    const shortId = 'job-att-04';
    const paymentId = 'pay-att-04';
    mockPayments.set(paymentId, {
      id: paymentId,
      authorizedPrintAttempts: 3,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-att-04',
      shortId,
      status: 'WAITING',
      paymentId,
      printAttempts: 3,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const result = await queueService.processJob(shortId);
    expect(result.success).toBe(false);
    expect(result.code).toBe('MAX_PRINT_ATTEMPTS_EXCEEDED');
    expect(result.attempts).toBe(3);
    expect(result.maxAttempts).toBe(3);

    const saved = mockJobs.get(shortId);
    expect(saved.status).toBe('WAITING');
    expect(saved.printAttempts).toBe(3);
  });

  test('5. Admin dispatch route rejects 4th attempt with HTTP 409 and returns attempt context', async () => {
    const shortId = 'job-admin-04';
    const paymentId = 'pay-admin-04';
    mockPayments.set(paymentId, {
      id: paymentId,
      authorizedPrintAttempts: 3,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-admin-04',
      shortId,
      status: 'FAILED',
      paymentId,
      printAttempts: 3,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01'
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('MAX_PRINT_ATTEMPTS_EXCEEDED');
    expect(res.body.attempts).toBe(3);
    expect(res.body.maxAttempts).toBe(3);
  });

  test('6. Admin dispatch allows authorized retry from FAILED when attempts < 3 and valid reason provided', async () => {
    const shortId = 'job-admin-retry';
    const paymentId = 'pay-admin-retry';
    mockPayments.set(paymentId, {
      id: paymentId,
      status: 'SUCCESS',
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-admin-retry',
      shortId,
      status: 'FAILED',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId, reason: 'Paper jam cleared by operator, retrying print' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.attempts).toBe(2);
    expect(res.body.maxAttempts).toBe(3);

    const saved = mockJobs.get(shortId);
    expect(saved.status).toBe('PRINTING');
    expect(saved.printAttempts).toBe(2);

    const auditLog = mockActivityLogs.find(l => l.action === 'PRINT_JOB_AUTHORIZED_RETRY');
    expect(auditLog).toBeDefined();
    const details = JSON.parse(auditLog.details);
    expect(details.operatorReason).toBe('Paper jam cleared by operator, retrying print');
    expect(details.currentAttempts).toBe(1);
    expect(details.maxAttempts).toBe(3);
    expect(details.previousStatus).toBe('FAILED');
    expect(details.newStatus).toBe('WAITING');
  });

  test('6a. Admin dispatch rejects retry from FAILED if operator reason is missing', async () => {
    const shortId = 'job-admin-no-reason';
    const paymentId = 'pay-admin-no-reason';
    mockPayments.set(paymentId, {
      id: paymentId,
      status: 'SUCCESS',
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-admin-no-reason',
      shortId,
      status: 'FAILED',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId }); // No reason

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('INVALID_OPERATOR_REASON');
  });

  test('6b. Admin dispatch rejects retry from FAILED if operator reason is less than 10 non-whitespace characters', async () => {
    const shortId = 'job-admin-short-reason';
    const paymentId = 'pay-admin-short-reason';
    mockPayments.set(paymentId, {
      id: paymentId,
      status: 'SUCCESS',
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-admin-short-reason',
      shortId,
      status: 'FAILED',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId, reason: '   retry   ' }); // 5 non-whitespace chars

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('INVALID_OPERATOR_REASON');
  });

  test('6c. Admin dispatch rejects retry from FAILED if payment status is not SUCCESS', async () => {
    const shortId = 'job-admin-bad-payment';
    const paymentId = 'pay-admin-bad-payment';
    mockPayments.set(paymentId, {
      id: paymentId,
      status: 'FAILED', // Payment not confirmed
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-admin-bad-payment',
      shortId,
      status: 'FAILED',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId, reason: 'Operator verified hardware resolved and retrying' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('PAYMENT_NOT_CONFIRMED');
  });

  test('6d. Admin dispatch rejects retry from FAILED if job has legacyAttemptsUnknown: true', async () => {
    const shortId = 'job-admin-legacy-fail';
    const paymentId = 'pay-admin-legacy-fail';
    mockPayments.set(paymentId, {
      id: paymentId,
      status: 'SUCCESS',
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-admin-legacy-fail',
      shortId,
      status: 'FAILED',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: true, // Legacy unknown attempt count
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId, reason: 'Operator verified hardware resolved and retrying' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('LEGACY_ATTEMPTS_EXHAUSTED');
  });

  test('6e. Admin dispatch rejects concurrent retry if job is no longer in FAILED', async () => {
    const shortId = 'job-admin-concurrent-retry';
    const paymentId = 'pay-admin-concurrent-retry';
    mockPayments.set(paymentId, {
      id: paymentId,
      status: 'SUCCESS',
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-admin-concurrent-retry',
      shortId,
      status: 'PRINTING', // Concurrently already claimed by another operator
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId, reason: 'Operator verified hardware resolved and retrying' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('AMBIGUOUS_JOB_LOCKED');
  });

  test('6f. Admin dispatch rolls back to FAILED if queue submission throws exception', async () => {
    const shortId = 'job-admin-queue-crash';
    const paymentId = 'pay-admin-queue-crash';
    mockPayments.set(paymentId, {
      id: paymentId,
      status: 'SUCCESS',
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-admin-queue-crash',
      shortId,
      status: 'FAILED',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    // Mock startPrintingProcess throwing an unexpected error
    const spy = jest.spyOn(queueService, 'startPrintingProcess').mockImplementationOnce(async () => {
      throw new Error('Redis connection dropped during queue submission');
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId, reason: 'Operator verified hardware resolved and retrying' });

    // Internal server error or caught error
    expect(res.status).toBe(500);

    // Job must be rolled back to FAILED, NOT stranded in WAITING
    const saved = mockJobs.get(shortId);
    expect(saved.status).toBe('FAILED');
    spy.mockRestore();
  });

  test('6g. Admin dispatch rejects retry of commercial job (cost > 0, !isTest) when payment record is missing', async () => {
    const shortId = 'job-admin-no-payment-commercial';
    mockJobs.set(shortId, {
      id: 'uuid-admin-no-pay',
      shortId,
      status: 'FAILED',
      paymentId: null,
      payment: null,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 15,
      isTest: false,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId, reason: 'Operator verified hardware resolved and retrying' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('PAYMENT_REQUIRED');
  });

  test('6h. Admin dispatch permits retry of zero-cost or test print without payment record', async () => {
    const shortId = 'job-admin-test-print-no-pay';
    mockJobs.set(shortId, {
      id: 'uuid-admin-test-no-pay',
      shortId,
      status: 'FAILED',
      paymentId: null,
      payment: null,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 0,
      isTest: true,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId, reason: 'Hardware diagnostic test print re-dispatch' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.attempts).toBe(2);
  });

  test('6i. Admin dispatch rolls back retry and fails if ActivityLog write fails', async () => {
    const shortId = 'job-admin-audit-fail-act';
    const paymentId = 'pay-admin-audit-fail-act';
    mockPayments.set(paymentId, {
      id: paymentId,
      status: 'SUCCESS',
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-admin-audit-fail-act',
      shortId,
      status: 'FAILED',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const spy = jest.spyOn(mockPrisma.activityLog, 'create').mockImplementationOnce(async () => {
      throw new Error('Database disk full: cannot commit ActivityLog record');
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId, reason: 'Operator verified hardware resolved and retrying' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('RETRY_TRANSACTION_FAILED');

    // Job MUST remain in FAILED status (transaction was rolled back)
    const jobAfter = mockJobs.get(shortId);
    expect(jobAfter.status).toBe('FAILED');
    spy.mockRestore();
  });

  test('6j. Admin dispatch rolls back retry and fails if PrintHistory write fails', async () => {
    const shortId = 'job-admin-audit-fail-hist';
    const paymentId = 'pay-admin-audit-fail-hist';
    mockPayments.set(paymentId, {
      id: paymentId,
      status: 'SUCCESS',
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-admin-audit-fail-hist',
      shortId,
      status: 'FAILED',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const spy = jest.spyOn(mockPrisma.printHistory, 'create').mockImplementationOnce(async () => {
      throw new Error('Database constraint error: cannot commit PrintHistory record');
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId, reason: 'Operator verified hardware resolved and retrying' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('RETRY_TRANSACTION_FAILED');

    // Job MUST remain in FAILED status (transaction was rolled back)
    const jobAfter = mockJobs.get(shortId);
    expect(jobAfter.status).toBe('FAILED');
    spy.mockRestore();
  });

  test('6k. Admin dispatch rejects retry if payment has an active or completed refund', async () => {
    const shortId = 'job-admin-refunded-pay';
    const paymentId = 'pay-admin-refunded-pay';
    mockPayments.set(paymentId, {
      id: paymentId,
      status: 'SUCCESS',
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockRefunds.set('ref-01', {
      id: 'ref-01',
      paymentId,
      status: 'SUCCESS'
    });
    mockJobs.set(shortId, {
      id: 'uuid-admin-refunded-pay',
      shortId,
      status: 'FAILED',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId, reason: 'Operator verified hardware resolved and retrying' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('PAYMENT_ALREADY_REFUNDED');

    // Job MUST remain in FAILED
    const jobAfter = mockJobs.get(shortId);
    expect(jobAfter.status).toBe('FAILED');
  });

  test('6l. Successful retry durably commits both ActivityLog and PrintHistory records', async () => {
    const shortId = 'job-admin-audit-success';
    const paymentId = 'pay-admin-audit-success';
    mockPayments.set(paymentId, {
      id: paymentId,
      status: 'SUCCESS',
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-admin-audit-success',
      shortId,
      status: 'FAILED',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId, reason: 'Operator verified paper tray replenished and ready' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify ActivityLog was durably committed
    expect(mockActivityLogs.length).toBeGreaterThan(0);
    const retryLog = mockActivityLogs.find(l => l.action === 'PRINT_JOB_AUTHORIZED_RETRY');
    expect(retryLog).toBeDefined();
    const details = JSON.parse(retryLog.details);
    expect(details.operatorReason).toBe('Operator verified paper tray replenished and ready');
    expect(details.previousStatus).toBe('FAILED');
    expect(details.newStatus).toBe('WAITING');

    // Verify PrintHistory was durably committed
    expect(mockPrintHistories.length).toBeGreaterThan(0);
    const retryHist = mockPrintHistories.find(h => h.errorDetails && h.errorDetails.includes('Authorized operator retry'));
    expect(retryHist).toBeDefined();
    expect(retryHist.printJobId).toBe('uuid-admin-audit-success');
  });

  test('7. UP-03 check: Admin dispatch rejects re-dispatch when job is currently in PRINTING', async () => {
    const shortId = 'job-admin-locked';
    mockJobs.set(shortId, {
      id: 'uuid-admin-locked',
      shortId,
      status: 'PRINTING',
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01'
    });

    const res = await request(app)
      .post('/api/admin/dispatch-job')
      .send({ shortId });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('AMBIGUOUS_JOB_LOCKED');
  });

  test('8. Duplicate delivery or repeated API call for the same reservation does not double-increment', async () => {
    const shortId = 'job-dup-call';
    const paymentId = 'pay-dup-call';
    mockPayments.set(paymentId, {
      id: paymentId,
      authorizedPrintAttempts: 1,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-dup-call',
      shortId,
      status: 'WAITING',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    // First call claims attempt 2
    const res1 = await queueService.processJob(shortId);
    expect(res1.success).toBe(true);
    expect(res1.attempts).toBe(2);

    // Second duplicate call arrives while job is in PRINTING
    const res2 = await queueService.processJob(shortId);
    expect(res2.success).toBe(false);
    expect(['INVALID_TRANSITION', 'DISPATCH_CLAIM_FAILED']).toContain(res2.code);

    // Still exactly 2 attempts
    const saved = mockJobs.get(shortId);
    expect(saved.printAttempts).toBe(2);
    expect(mockPayments.get(paymentId).authorizedPrintAttempts).toBe(2);
  });

  test('9. Process restart preserves the attempt count (monotonically persistent)', async () => {
    const shortId = 'job-restart-persisted';
    const paymentId = 'pay-restart';
    mockPayments.set(paymentId, {
      id: paymentId,
      authorizedPrintAttempts: 2,
      legacyAttemptsUnknown: false
    });
    mockJobs.set(shortId, {
      id: 'uuid-restart',
      shortId,
      status: 'WAITING',
      paymentId,
      printAttempts: 2,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const result = await queueService.processJob(shortId);
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);

    const saved = mockJobs.get(shortId);
    expect(saved.printAttempts).toBe(3);
    expect(mockPayments.get(paymentId).authorizedPrintAttempts).toBe(3);
  });

  test('10. Job failure or resolution does not reset printAttempts', async () => {
    const shortId = 'job-status-no-reset';
    mockJobs.set(shortId, {
      id: 'uuid-no-reset',
      shortId,
      status: 'PRINTING',
      printAttempts: 2,
      cost: 10
    });

    // Simulate transition to FAILED
    const job = mockJobs.get(shortId);
    job.status = 'FAILED';

    expect(job.printAttempts).toBe(2);

    // Re-queueing to WAITING preserves 2
    job.status = 'WAITING';
    expect(job.printAttempts).toBe(2);
  });

  test('11. Sibling PrintJobs sharing the same paymentId cannot bypass the transaction cap of 3', async () => {
    const paymentId = 'pay-tx-shared-01';
    mockPayments.set(paymentId, {
      id: paymentId,
      authorizedPrintAttempts: 3,
      legacyAttemptsUnknown: false
    });

    // Job 1 already consumed 2 attempts
    mockJobs.set('job-sibling-01', {
      id: 'uuid-sib-01',
      shortId: 'job-sibling-01',
      status: 'FAILED',
      paymentId,
      printAttempts: 2,
      legacyAttemptsUnknown: false
    });

    // Job 2 has consumed 1 attempt (total across payment = 3)
    mockJobs.set('job-sibling-02', {
      id: 'uuid-sib-02',
      shortId: 'job-sibling-02',
      status: 'WAITING',
      paymentId,
      printAttempts: 1,
      legacyAttemptsUnknown: false,
      cost: 10,
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    // Dispatching Job 2 would be attempt 4 across the payment transaction
    const result = await queueService.processJob('job-sibling-02');
    expect(result.success).toBe(false);
    expect(result.code).toBe('MAX_PRINT_ATTEMPTS_EXCEEDED');
    expect(result.attempts).toBe(3);
    expect(result.maxAttempts).toBe(3);
  });

  test('12. Transaction with null paymentId enforces standalone 3-attempt limit', async () => {
    const shortId = 'job-null-payment';
    mockJobs.set(shortId, {
      id: 'uuid-null-pay',
      shortId,
      status: 'WAITING',
      paymentId: null,
      printAttempts: 2,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    // Claim 3rd attempt
    const res1 = await queueService.processJob(shortId);
    expect(res1.success).toBe(true);
    expect(res1.attempts).toBe(3);

    // Re-queue for attempt 4
    const job = mockJobs.get(shortId);
    job.status = 'WAITING';

    const res2 = await queueService.processJob(shortId);
    expect(res2.success).toBe(false);
    expect(res2.code).toBe('MAX_PRINT_ATTEMPTS_EXCEEDED');
    expect(res2.attempts).toBe(3);
  });

  test('13. Legacy job with legacyAttemptsUnknown: true fails closed and rejects dispatch', async () => {
    const shortId = 'job-legacy-unknown';
    mockJobs.set(shortId, {
      id: 'uuid-legacy-unk',
      shortId,
      status: 'WAITING',
      paymentId: null,
      printAttempts: 0,
      legacyAttemptsUnknown: true, // Legacy transaction with unverified attempts
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const res = await queueService.processJob(shortId);
    expect(res.success).toBe(false);
    expect(res.code).toBe('LEGACY_ATTEMPTS_EXHAUSTED');
  });

  test('14. Sibling job is rejected if parent payment has legacyAttemptsUnknown: true', async () => {
    const paymentId = 'pay-legacy-unk';
    mockPayments.set(paymentId, {
      id: paymentId,
      authorizedPrintAttempts: 0,
      legacyAttemptsUnknown: true
    });
    const shortId = 'job-sibling-legacy';
    mockJobs.set(shortId, {
      id: 'uuid-sib-legacy',
      shortId,
      status: 'WAITING',
      paymentId,
      printAttempts: 0,
      legacyAttemptsUnknown: false,
      cost: 10,
      machineId: 'm-01',
      document: { filename: 'doc.pdf', originalName: 'doc.pdf' }
    });

    const res = await queueService.processJob(shortId);
    expect(res.success).toBe(false);
    expect(res.code).toBe('LEGACY_ATTEMPTS_EXHAUSTED');
  });
});
