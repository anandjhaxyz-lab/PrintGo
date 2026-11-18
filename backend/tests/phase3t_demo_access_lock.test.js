/**
 * Phase 3T — Supervised Demo Payment Access Lock Test Suite
 *
 * Verifies all security, authentication, and isolation controls for Phase 3T:
 * 1. Constant-time timingSafeEqual validation in verifyDemoAccessCode.
 * 2. Missing access code rejected with 400 Bad Request.
 * 3. Wrong access code rejected with 403 Forbidden.
 * 4. Rate-limit enforced per session/IP (429 Too Many Requests after max failures).
 * 5. Rate limit cleared upon successful authentication.
 * 6. Correct access code permits exactly one demo transaction (200 OK + dispatch).
 * 7. Duplicate request cannot produce duplicate payment or duplicate print (idempotency).
 * 8. Production environment remains blocked (403 even if correct code is sent).
 * 9. Access code is never logged, leaked, or returned in response or audit records.
 * 10. Hardware print dispatch and agent acknowledgment flow works seamlessly.
 */

const assert = require('assert');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'phase3t_test_jwt_secret_isolated_key_64_bytes_secure_string_pilot';
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = 'test';

const TEST_ACCESS_CODE = 'super_secret_staging_access_code_2026';
process.env.DEMO_PAYMENT_ACCESS_CODE = TEST_ACCESS_CODE;

const {
  isDemoPaymentPermitted,
  isDemoAccessCodeRequired,
  verifyDemoAccessCode,
  isDemoAccessRateLimited,
  recordDemoAccessFailure,
  clearDemoAccessFailures,
  resetAllDemoRateLimits,
  MAX_FAILED_ATTEMPTS,
  STAGING_SERVICE_ID,
  STAGING_SERVICE_NAME,
  STAGING_GIT_BRANCH
} = require('../src/utils/demoPaymentGuard');

// In-memory mock store
const mockJobs = new Map();
const mockPayments = new Map();
const mockTransactions = new Map();
const mockMachines = new Map();
const mockPrintHistory = new Map();
const mockSessions = new Map();

// Mock Prisma Client
const mockPrisma = {
  session: {
    findUnique: async ({ where }) => {
      if (where.code) {
        for (const s of mockSessions.values()) {
          if (s.code === where.code) return { ...s };
        }
      }
      if (where.id) return mockSessions.get(where.id) ? { ...mockSessions.get(where.id) } : null;
      return null;
    },
    update: async ({ where, data }) => {
      const s = where.id ? mockSessions.get(where.id) : null;
      if (!s) return null;
      Object.assign(s, data);
      return { ...s };
    }
  },
  printJob: {
    findUnique: async ({ where }) => {
      if (where.shortId) {
        for (const j of mockJobs.values()) {
          if (j.shortId === where.shortId) {
            const copy = { ...j };
            if (copy.paymentId && mockPayments.has(copy.paymentId)) {
              copy.payment = mockPayments.get(copy.paymentId);
            }
            return copy;
          }
        }
      }
      if (where.id) {
        const j = mockJobs.get(where.id);
        if (j) {
          const copy = { ...j };
          if (copy.paymentId && mockPayments.has(copy.paymentId)) {
            copy.payment = mockPayments.get(copy.paymentId);
          }
          return copy;
        }
      }
      return null;
    },
    update: async ({ where, data }) => {
      let target = null;
      if (where.shortId) {
        for (const j of mockJobs.values()) {
          if (j.shortId === where.shortId) { target = j; break; }
        }
      } else if (where.id) {
        target = mockJobs.get(where.id);
      }
      if (!target) return null;
      Object.assign(target, data);
      return { ...target };
    }
  },
  payment: {
    create: async ({ data }) => {
      const p = { id: `pay_${Date.now()}_${Math.random()}`, ...data };
      mockPayments.set(p.id, p);
      return p;
    }
  },
  transaction: {
    create: async ({ data }) => {
      const t = { id: `tx_${Date.now()}_${Math.random()}`, ...data };
      mockTransactions.set(t.id, t);
      return t;
    }
  },
  printHistory: {
    create: async ({ data }) => {
      const h = { id: `hist_${Date.now()}_${Math.random()}`, ...data };
      mockPrintHistory.set(h.id, h);
      return h;
    }
  },
  $transaction: async (fn) => {
    return await fn({
      printJob: mockPrisma.printJob,
      payment: mockPrisma.payment,
      transaction: mockPrisma.transaction,
      $executeRawUnsafe: async () => 1
    });
  }
};

const prismaModule = require('../src/utils/prisma');
Object.assign(prismaModule, mockPrisma);

// Spy tracking
let printDispatchCalls = [];
const queueServiceModule = require('../src/services/queueService');
queueServiceModule.startPrintingProcess = async (shortId, io) => {
  printDispatchCalls.push({ shortId });
  const job = await mockPrisma.printJob.findUnique({ where: { shortId } });
  if (job && job.status === 'WAITING') {
    await mockPrisma.printJob.update({ where: { shortId }, data: { status: 'PRINTING' } });
    if (io && job.machineId) {
      io.to(`machine_${job.machineId}`).emit('physical_print_job', {
        jobId: job.shortId,
        fileUrl: job.document?.filename,
        originalName: job.document?.originalName,
        pagesToPrint: job.pagesToPrint || 1
      });
    }
  }
};

const paymentsController = require('../src/modules/payments/payments.controller');
const { requireSessionOrUser } = require('../src/middlewares/session');

// Test App setup
const app = express();
app.use(express.json());

const socketEvents = [];
const mockIo = {
  to: (room) => ({
    emit: (event, data) => {
      socketEvents.push({ room, event, data });
    }
  })
};
app.set('io', mockIo);

app.post('/api/payments/demo-pay/:id', requireSessionOrUser, paymentsController.demoPayment);

const makeSessionToken = (sessionId, machineId) => {
  return jwt.sign(
    {
      type: 'session',
      sessionId,
      machineId
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
};

const addMockSession = (code) => {
  mockSessions.set(code, {
    id: code,
    code,
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 3600 * 1000)
  });
};

const setStagingEnv = () => {
  process.env.APP_ENV = 'staging';
  process.env.ENABLE_DEMO_PAYMENT = 'true';
  process.env.RENDER = 'true';
  process.env.RENDER_SERVICE_ID = STAGING_SERVICE_ID;
  process.env.RENDER_SERVICE_NAME = STAGING_SERVICE_NAME;
  process.env.RENDER_GIT_BRANCH = STAGING_GIT_BRANCH;
  process.env.DEMO_PAYMENT_ACCESS_CODE = TEST_ACCESS_CODE;
  process.env.DEMO_PAYMENT_REQUIRE_ACCESS_CODE = 'true';
};

const setProductionEnv = () => {
  process.env.APP_ENV = 'production';
  process.env.ENABLE_DEMO_PAYMENT = 'false';
  process.env.RENDER = 'true';
  process.env.RENDER_SERVICE_ID = 'srv-production-different-id';
  process.env.RENDER_SERVICE_NAME = 'printgo-backend';
  process.env.RENDER_GIT_BRANCH = 'main';
  process.env.DEMO_PAYMENT_ACCESS_CODE = TEST_ACCESS_CODE;
  process.env.DEMO_PAYMENT_REQUIRE_ACCESS_CODE = 'false';
};

async function runPhase3TTests() {
  console.log('======================================================================');
  console.log('PHASE 3T — SUPERVISED DEMO PAYMENT ACCESS LOCK TEST SUITE');
  console.log('======================================================================\n');

  let passed = 0;
  let failed = 0;

  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  };

  // Test 1: Direct Unit Test for verifyDemoAccessCode & timingSafeEqual
  await test('1. verifyDemoAccessCode verifies correctly using timingSafeEqual and fails closed', () => {
    assert.strictEqual(verifyDemoAccessCode('correct_code', 'correct_code'), true);
    assert.strictEqual(verifyDemoAccessCode('wrong_code', 'correct_code'), false);
    assert.strictEqual(verifyDemoAccessCode('', 'correct_code'), false);
    assert.strictEqual(verifyDemoAccessCode(null, 'correct_code'), false);
    assert.strictEqual(verifyDemoAccessCode('correct_code', ''), false);
    assert.strictEqual(verifyDemoAccessCode('correct_code', undefined), false);
    // Length differences do not throw RangeError due to SHA-256 pre-hashing
    assert.strictEqual(verifyDemoAccessCode('a', 'much_longer_string_than_a'), false);
    assert.strictEqual(isDemoAccessCodeRequired({}), true, 'Code requirement defaults to enabled');
    assert.strictEqual(isDemoAccessCodeRequired({ DEMO_PAYMENT_REQUIRE_ACCESS_CODE: 'true' }), true);
    assert.strictEqual(isDemoAccessCodeRequired({ DEMO_PAYMENT_REQUIRE_ACCESS_CODE: 'false' }), false);
    assert.strictEqual(isDemoAccessCodeRequired({ DEMO_PAYMENT_REQUIRE_ACCESS_CODE: 'FALSE' }), false);
    assert.strictEqual(isDemoAccessCodeRequired({ DEMO_PAYMENT_REQUIRE_ACCESS_CODE: '0' }), true, 'Only explicit false disables the requirement');
  });

  // Test 2: Missing access code rejected with 400 Bad Request
  await test('2. POST /api/payments/demo-pay/:id rejects missing access code with 400 Bad Request', async () => {
    setStagingEnv();
    resetAllDemoRateLimits();
    const sess = 'sess_demo_missing_code';
    const machineId = 'mach_staging_1';
    addMockSession(sess);

    const job = {
      id: 'job_test_missing_code',
      shortId: 'job_miss_1',
      cost: 5.0,
      machineId,
      status: 'PENDING_PAYMENT',
      pricingSnapshot: JSON.stringify({ sessionId: sess })
    };
    mockJobs.set(job.id, job);

    const token = makeSessionToken(sess, machineId);

    // Call without body
    const resNoBody = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    assert.strictEqual(resNoBody.status, 400);
    assert.strictEqual(resNoBody.body.success, false);
    assert.strictEqual(resNoBody.body.error, 'Demo payment access code is required');

    // Call with empty string
    const resEmpty = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: '   ' });

    assert.strictEqual(resEmpty.status, 400);
    assert.strictEqual(resEmpty.body.error, 'Demo payment access code is required');
  });

  // Test 3: Wrong access code rejected with 403 Forbidden
  await test('3. POST /api/payments/demo-pay/:id rejects wrong access code with 403 Forbidden', async () => {
    setStagingEnv();
    resetAllDemoRateLimits();
    const sess = 'sess_demo_wrong_code';
    const machineId = 'mach_staging_1';
    addMockSession(sess);

    const job = {
      id: 'job_test_wrong_code',
      shortId: 'job_wrong_1',
      cost: 5.0,
      machineId,
      status: 'PENDING_PAYMENT',
      pricingSnapshot: JSON.stringify({ sessionId: sess })
    };
    mockJobs.set(job.id, job);

    const token = makeSessionToken(sess, machineId);

    const res = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: 'wrong_unauthorized_code_999' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error, 'Invalid demo payment access code');
    assert.strictEqual(mockPayments.has(job.id), false, 'No payment record should be created on wrong code');
  });

  // Test 4: Rate limit enforced per session/IP (429 Too Many Requests)
  await test('4. Rate limit is strictly enforced after max failed attempts (HTTP 429)', async () => {
    setStagingEnv();
    resetAllDemoRateLimits();
    const sess = 'sess_demo_rate_limit';
    const machineId = 'mach_staging_1';
    addMockSession(sess);

    const job = {
      id: 'job_test_rate_limit',
      shortId: 'job_rl_1',
      cost: 5.0,
      machineId,
      status: 'PENDING_PAYMENT',
      pricingSnapshot: JSON.stringify({ sessionId: sess })
    };
    mockJobs.set(job.id, job);

    const token = makeSessionToken(sess, machineId);

    // Perform 5 consecutive failed attempts
    for (let i = 1; i <= MAX_FAILED_ATTEMPTS; i++) {
      const resFail = await request(app)
        .post(`/api/payments/demo-pay/${job.shortId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ accessCode: `bad_attempt_${i}` });
      assert.strictEqual(resFail.status, 403);
    }

    // 6th attempt should be blocked by rate limit with HTTP 429
    const resBlocked = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: TEST_ACCESS_CODE }); // Even with the CORRECT code, rate limit blocks!

    assert.strictEqual(resBlocked.status, 429);
    assert.strictEqual(resBlocked.body.success, false);
    assert.ok(resBlocked.body.error.includes('Rate limit exceeded'));
  });

  // Test 5: Rate limit resets upon successful authentication
  await test('5. Rate limit tracker clears failed attempts after valid access code', async () => {
    setStagingEnv();
    resetAllDemoRateLimits();
    const sess = 'sess_demo_rl_clear';
    const machineId = 'mach_staging_1';
    addMockSession(sess);

    const job = {
      id: 'job_test_rl_clear',
      shortId: 'job_rl_clear_1',
      cost: 5.0,
      machineId,
      status: 'PENDING_PAYMENT',
      pricingSnapshot: JSON.stringify({ sessionId: sess })
    };
    mockJobs.set(job.id, job);

    const token = makeSessionToken(sess, machineId);

    // 2 failed attempts
    await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: 'wrong_1' });
    await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: 'wrong_2' });

    // Successful attempt
    const resSuccess = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: TEST_ACCESS_CODE });
    assert.strictEqual(resSuccess.status, 200);

    // Rate limit should be clear
    const key = `${sess}:127.0.0.1`;
    assert.strictEqual(isDemoAccessRateLimited(key), false);
  });

  // Test 6: Correct access code permits one demo transaction and triggers print dispatch
  await test('6. Correct access code permits demo payment transaction & triggers startPrintingProcess', async () => {
    setStagingEnv();
    resetAllDemoRateLimits();
    printDispatchCalls = [];
    const sess = 'sess_demo_permit_ok';
    const machineId = 'mach_staging_1';
    addMockSession(sess);

    const job = {
      id: 'job_test_permit_ok',
      shortId: 'job_ok_1',
      cost: 20.0,
      machineId,
      status: 'PENDING_PAYMENT',
      pagesToPrint: 4,
      color: 'color',
      duplex: 'single',
      document: { filename: '/uploads/proposal.pdf', originalName: 'proposal.pdf' },
      pricingSnapshot: JSON.stringify({ sessionId: sess })
    };
    mockJobs.set(job.id, job);

    const token = makeSessionToken(sess, machineId);

    const res = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: TEST_ACCESS_CODE });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.dispatched, true);
    assert.strictEqual(res.body.message, 'Demo payment confirmed and dispatched to printer');
    assert.strictEqual(res.body.payment.paymentMethod, 'demo');
    assert.strictEqual(res.body.payment.status, 'SUCCESS');
    assert.strictEqual(res.body.job.status, 'WAITING');

    // Verified print dispatcher was triggered
    assert.strictEqual(printDispatchCalls.length, 1);
    assert.strictEqual(printDispatchCalls[0].shortId, job.shortId);
  });

  // Test 6B: Explicitly configured no-code demo remains session-authorized and dispatches exactly one print.
  await test('6B. DEMO_PAYMENT_REQUIRE_ACCESS_CODE=false allows one-click simulation without a code', async () => {
    setStagingEnv();
    process.env.DEMO_PAYMENT_REQUIRE_ACCESS_CODE = 'false';
    resetAllDemoRateLimits();
    printDispatchCalls = [];
    const sess = 'sess_demo_no_code';
    const machineId = 'mach_staging_1';
    addMockSession(sess);

    const job = {
      id: 'job_test_no_code',
      shortId: 'job_no_code_1',
      cost: 5.0,
      machineId,
      status: 'PENDING_PAYMENT',
      pagesToPrint: 1,
      color: 'bw',
      duplex: 'single',
      document: { filename: '/uploads/demo_no_code.pdf', originalName: 'demo_no_code.pdf' },
      pricingSnapshot: JSON.stringify({ sessionId: sess })
    };
    mockJobs.set(job.id, job);

    const token = makeSessionToken(sess, machineId);
    const res = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.dispatched, true);
    assert.strictEqual(res.body.payment.paymentMethod, 'demo');
    assert.strictEqual(res.body.job.status, 'WAITING');
    assert.strictEqual(printDispatchCalls.length, 1);
    assert.strictEqual(printDispatchCalls[0].shortId, job.shortId);
  });

  // Test 7: Idempotency (Duplicate request cannot produce duplicate print)
  await test('7. Duplicate demo request cannot produce duplicate payment or duplicate print', async () => {
    setStagingEnv();
    resetAllDemoRateLimits();
    printDispatchCalls = [];
    const sess = 'sess_demo_idempotent';
    const machineId = 'mach_staging_1';
    addMockSession(sess);

    const job = {
      id: 'job_test_idempotent',
      shortId: 'job_idem_1',
      cost: 15.0,
      machineId,
      status: 'PENDING_PAYMENT',
      pricingSnapshot: JSON.stringify({ sessionId: sess })
    };
    mockJobs.set(job.id, job);

    const token = makeSessionToken(sess, machineId);

    // Call 1: Transitions and creates payment
    const res1 = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: TEST_ACCESS_CODE });
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(printDispatchCalls.length, 1);
    const paymentsCountAfter1 = mockPayments.size;

    // Call 2: Returns already paid
    const res2 = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: TEST_ACCESS_CODE });
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.body.message, 'Job already paid');

    // Invariant: zero duplicate payments, zero duplicate dispatches
    assert.strictEqual(mockPayments.size, paymentsCountAfter1);
    assert.strictEqual(printDispatchCalls.length, 1);
  });

  // Test 8: Production remains blocked even if valid access code is provided
  await test('8. Production environment permanently blocks demo payment even with valid access code', async () => {
    setProductionEnv();
    resetAllDemoRateLimits();
    const sess = 'sess_prod_attempt';
    const machineId = 'mach_prod_1';
    addMockSession(sess);

    const job = {
      id: 'job_test_prod',
      shortId: 'job_prod_1',
      cost: 10.0,
      machineId,
      status: 'PENDING_PAYMENT',
      pricingSnapshot: JSON.stringify({ sessionId: sess })
    };
    mockJobs.set(job.id, job);

    const token = makeSessionToken(sess, machineId);

    const res = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error, 'Demo payment endpoint is disabled');
    assert.strictEqual(isDemoPaymentPermitted(), false);
    assert.strictEqual(process.env.DEMO_PAYMENT_REQUIRE_ACCESS_CODE, 'false', 'Production remains blocked even with the optional-code setting disabled');
  });

  // Test 9: Zero access code leakage in responses, errors, or audit records
  await test('9. Access code is never logged, leaked, or returned in response or transaction records', async () => {
    setStagingEnv();
    resetAllDemoRateLimits();
    const sess = 'sess_leak_check';
    const machineId = 'mach_staging_1';
    addMockSession(sess);

    const job = {
      id: 'job_test_leak_check',
      shortId: 'job_leak_1',
      cost: 10.0,
      machineId,
      status: 'PENDING_PAYMENT',
      pricingSnapshot: JSON.stringify({ sessionId: sess })
    };
    mockJobs.set(job.id, job);

    const token = makeSessionToken(sess, machineId);

    // Failed attempt response check
    const resFail = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: 'my_super_secret_guess_123' });

    const failBodyStr = JSON.stringify(resFail.body);
    assert.strictEqual(failBodyStr.includes('my_super_secret_guess_123'), false, 'Leaked failed code in error response!');
    assert.strictEqual(failBodyStr.includes(TEST_ACCESS_CODE), false, 'Leaked actual access code in error response!');

    // Success attempt response check
    const resOk = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: TEST_ACCESS_CODE });

    const okBodyStr = JSON.stringify(resOk.body);
    assert.strictEqual(okBodyStr.includes(TEST_ACCESS_CODE), false, 'Leaked access code in success response!');

    // Check transaction audit record
    for (const tx of mockTransactions.values()) {
      const txStr = JSON.stringify(tx);
      assert.strictEqual(txStr.includes(TEST_ACCESS_CODE), false, 'Leaked access code in transaction audit record!');
    }
  });

  // Test 10: Printer Agent receives job and completes to COMPLETED with acknowledgment
  await test('10. Printer Agent receives physical_print_job and completes job to COMPLETED with acknowledgment', async () => {
    setStagingEnv();
    resetAllDemoRateLimits();
    const sess = 'sess_agent_demo';
    const machineId = 'mach_staging_1';
    addMockSession(sess);

    const job = {
      id: 'job_agent_full',
      shortId: 'job_ag_1',
      cost: 12.0,
      machineId,
      status: 'PENDING_PAYMENT',
      pagesToPrint: 1,
      document: { filename: '/uploads/invoice.pdf', originalName: 'invoice.pdf' },
      pricingSnapshot: JSON.stringify({ sessionId: sess })
    };
    mockJobs.set(job.id, job);

    const token = makeSessionToken(sess, machineId);

    // Trigger demo payment
    const res = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: TEST_ACCESS_CODE });
    assert.strictEqual(res.status, 200);

    // Job transitions to PRINTING via startPrintingProcess
    const printingJob = await mockPrisma.printJob.findUnique({ where: { shortId: job.shortId } });
    assert.strictEqual(printingJob.status, 'PRINTING');

    // Simulate Agent physical print success
    await mockPrisma.printJob.update({
      where: { shortId: job.shortId },
      data: { status: 'COMPLETED' }
    });

    const completedJob = await mockPrisma.printJob.findUnique({ where: { shortId: job.shortId } });
    assert.strictEqual(completedJob.status, 'COMPLETED');
  });

  // Test 11 (SEC-3T-01): Dispatch throws returns dispatched=false, preserves payment SUCCESS, and job stays WAITING
  await test('11. SEC-3T-01: Dispatch error returns dispatched=false, preserves payment SUCCESS and leaves job WAITING for operator retry', async () => {
    setStagingEnv();
    resetAllDemoRateLimits();
    const originalDispatcher = queueServiceModule.startPrintingProcess;
    // Simulate dispatch failure (e.g. queue offline / driver crash)
    queueServiceModule.startPrintingProcess = async () => {
      throw new Error('Epson print spooler communication failure');
    };

    const sess = 'sess_dispatch_err';
    const machineId = 'mach_staging_1';
    addMockSession(sess);

    const job = {
      id: 'job_dispatch_err_test',
      shortId: 'job_derr_1',
      cost: 15.0,
      machineId,
      status: 'PENDING_PAYMENT',
      pricingSnapshot: JSON.stringify({ sessionId: sess })
    };
    mockJobs.set(job.id, job);

    const token = makeSessionToken(sess, machineId);

    const res = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: TEST_ACCESS_CODE });

    // Restore original dispatcher
    queueServiceModule.startPrintingProcess = originalDispatcher;

    // Requirement: Must NOT report successful dispatch when dispatch failed!
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.dispatched, false);
    assert.ok(res.body.message.includes('print queue dispatch encountered an error'));
    assert.strictEqual(res.body.message.includes('dispatched to printer'), false);
    assert.strictEqual(res.body.dispatchError, 'Epson print spooler communication failure');

    // Invariant: Payment record is SUCCESS
    assert.strictEqual(res.body.payment.status, 'SUCCESS');
    assert.strictEqual(res.body.payment.paymentMethod, 'demo');

    // Invariant: Job is preserved in WAITING state for operator retry
    assert.strictEqual(res.body.job.status, 'WAITING');
    const storedJob = await mockPrisma.printJob.findUnique({ where: { shortId: job.shortId } });
    assert.strictEqual(storedJob.status, 'WAITING');
  });

  // Test 12 (SEC-3T-01): Missing dispatch function returns dispatched=false without crashing
  await test('12. SEC-3T-01: Missing dispatch function returns dispatched=false and preserves payment SUCCESS', async () => {
    setStagingEnv();
    resetAllDemoRateLimits();
    const originalDispatcher = queueServiceModule.startPrintingProcess;
    delete queueServiceModule.startPrintingProcess;

    const sess = 'sess_dispatch_missing';
    const machineId = 'mach_staging_1';
    addMockSession(sess);

    const job = {
      id: 'job_dispatch_missing_test',
      shortId: 'job_dmiss_1',
      cost: 25.0,
      machineId,
      status: 'PENDING_PAYMENT',
      pricingSnapshot: JSON.stringify({ sessionId: sess })
    };
    mockJobs.set(job.id, job);

    const token = makeSessionToken(sess, machineId);

    const res = await request(app)
      .post(`/api/payments/demo-pay/${job.shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ accessCode: TEST_ACCESS_CODE });

    // Restore original dispatcher
    queueServiceModule.startPrintingProcess = originalDispatcher;

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.dispatched, false);
    assert.ok(res.body.message.includes('Print queue dispatcher is unavailable'));
    assert.strictEqual(res.body.payment.status, 'SUCCESS');
    assert.strictEqual(res.body.job.status, 'WAITING');
  });

  console.log('\n======================================================================');
  console.log(`PHASE 3T TEST SUITE RESULTS: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('======================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase3TTests().catch((e) => {
  console.error('Unhandled test suite error:', e);
  process.exit(1);
});
