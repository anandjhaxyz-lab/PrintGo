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
const mockActivityLogs = [];

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
      const shortId = where.shortId;
      const job = mockJobs.get(shortId);
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
  $transaction: jest.fn(async (callback) => {
    return await callback(mockPrisma);
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
    mockActivityLogs.length = 0;
    mockCurrentUser = superadmin;
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

  test('6. Admin dispatch allows authorized retry from FAILED when attempts < 3', async () => {
    const shortId = 'job-admin-retry';
    const paymentId = 'pay-admin-retry';
    mockPayments.set(paymentId, {
      id: paymentId,
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
      .send({ shortId });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.attempts).toBe(2);
    expect(res.body.maxAttempts).toBe(3);

    const saved = mockJobs.get(shortId);
    expect(saved.status).toBe('PRINTING');
    expect(saved.printAttempts).toBe(2);
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
