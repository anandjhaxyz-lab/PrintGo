/**
 * S3K PrintGo - Batch 1 Backend Payment Safety Test Suite
 * Executes against printgo_disposable_target ONLY (never printgo_db, never live Cashfree, never physical printer).
 */

const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const axios = require('axios');

// Enforce strict DB isolation BEFORE importing prisma client
const assertDisposableDb = () => {
  const dbUrl = process.env.DATABASE_URL || '';
  let parsed;
  try {
    parsed = new URL(dbUrl);
  } catch {
    throw new Error('DATABASE_URL must be set to printgo_disposable_target on port 5433');
  }
  const dbName = parsed.pathname.replace(/^\//, '');
  if (dbName !== 'printgo_disposable_target' || parsed.port !== '5433') {
    throw new Error(`SAFETY ABORT: Refusing to run against DB='${dbName}' port='${parsed.port}'. Expected printgo_disposable_target:5433`);
  }
};

assertDisposableDb();

// Configure safe sandbox-only mock credentials for tests
process.env.JWT_SECRET = process.env.JWT_SECRET || 'batch1_test_jwt_secret_key_for_disposable_only';
process.env.NODE_ENV = 'test';
process.env.CASHFREE_ENV = 'sandbox';
delete process.env.CASHFREE_ENVIRONMENT;
process.env.CASHFREE_APP_ID = 'MOCK_SANDBOX_APP_98765';
process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_batch1_verification_secret_key';
process.env.FRONTEND_URL = 'https://pilot.printgo.local';
process.env.PUBLIC_APP_URL = 'https://pilot.printgo.local';
delete process.env.ENABLE_DEMO_PAYMENT;

const prisma = require('../src/utils/prisma');
const cashfreeGateway = require('../src/services/cashfreeGateway.adapter');
const queueService = require('../src/services/queueService');
const { generateInvoiceForJob } = require('../src/services/invoice.service');
const { validateCashfreeConfig } = require('../src/config/cashfree.config');
const paymentsService = require('../src/modules/payments/payments.service');

// Prevent any real hardware dispatch during Batch 1 tests while counting dispatch calls
let dispatchCalls = [];
queueService.startPrintingProcess = (shortId) => {
  dispatchCalls.push(shortId);
};

// Re-require routes/controller after stubbing queueService.startPrintingProcess
const paymentsRoutes = require('../src/modules/payments/payments.routes');
const { errorHandler } = require('../src/middlewares/error');

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));
app.use(cookieParser());
app.set('io', { to: () => ({ emit: () => {} }) });
app.use('/api/payments', paymentsRoutes);
app.use(errorHandler);

const signWebhook = (timestamp, rawBody, secret = process.env.CASHFREE_SECRET_KEY) => {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}${rawBody}`)
    .digest('base64');
};

async function runBatch1Suite() {
  console.log('======================================================================');
  console.log('S3K PRINTGO — BATCH 1 BACKEND PAYMENT SAFETY TEST SUITE (DISPOSABLE DB)');
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
      console.error(`   Details: ${err.stack || err.message}\n`);
      failed++;
    }
  };

  // Setup isolated test company + machines + admin user
  const suffix = Date.now();
  const companyA = await prisma.company.create({
    data: { name: `Batch1 Company A ${suffix}`, contactEmail: `compA_${suffix}@test.local` }
  });
  const companyB = await prisma.company.create({
    data: { name: `Batch1 Company B ${suffix}`, contactEmail: `compB_${suffix}@test.local` }
  });
  const machineA = await prisma.machine.create({
    data: {
      name: `Batch1 Machine A ${suffix}`,
      location: 'Pilot Desk A',
      machineKey: `mk_b1_a_${suffix}`,
      status: 'ACTIVE',
      lastOnline: new Date(),
      companyId: companyA.id
    }
  });
  const machineB = await prisma.machine.create({
    data: {
      name: `Batch1 Machine B ${suffix}`,
      location: 'Pilot Desk B',
      machineKey: `mk_b1_b_${suffix}`,
      status: 'ACTIVE',
      lastOnline: new Date(),
      companyId: companyB.id
    }
  });
  // Online telemetry is required by the payment-order availability gate.
  await prisma.printerStatus.create({
    data: { machineId: machineA.id, isOnline: true, paperStatus: 'OK', tonerStatus: 'OK', jamStatus: false, timestamp: new Date() }
  });
  const doc = await prisma.document.create({
    data: {
      originalName: 'batch1_test.pdf',
      filename: '/uploads/batch1_test.pdf',
      mimetype: 'application/pdf',
      size: 1024,
      pages: 1
    }
  });
  const franchiseeA = await prisma.user.create({
    data: {
      email: `franA_${suffix}@test.local`,
      password: 'hashed_password_placeholder',
      name: 'Franchisee A',
      role: 'FRANCHISEE',
      companyId: companyA.id
    }
  });
  const superadmin = await prisma.user.create({
    data: {
      email: `super_${suffix}@test.local`,
      password: 'hashed_password_placeholder',
      name: 'Superadmin',
      role: 'SUPERADMIN'
    }
  });

  const makeSessionToken = (sessionId, machineId) => jwt.sign(
    { type: 'session', sessionId, machineId },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  const makeUserToken = (userId) => jwt.sign(
    { id: userId },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  // Track only sessions created by this run; never update or delete pre-existing sessions.
  const createdSessionIds = new Map();
  const ensureSession = async (code, machine) => {
    if (createdSessionIds.has(code)) {
      return prisma.session.findUnique({ where: { id: createdSessionIds.get(code) } });
    }

    const existingSession = await prisma.session.findUnique({ where: { code } });
    if (existingSession) {
      throw new Error(`Fixture session code collision; refusing to modify existing session: ${code}`);
    }

    const session = await prisma.session.create({
      data: { code, machineId: machine.id, status: 'CONNECTED', expiresAt: new Date(Date.now() + 60 * 60 * 1000) }
    });
    createdSessionIds.set(code, session.id);
    return session;
  };

  let jobSeq = 1;
  const createJob = async ({ machine = machineA, sessionId = `sess_${suffix}_1`, cost = 12 } = {}) => {
    await ensureSession(sessionId, machine);
    const shortId = `b1j${suffix.toString().slice(-5)}${jobSeq++}`;
    return prisma.printJob.create({
      data: {
        shortId,
        documentId: doc.id,
        machineId: machine.id,
        pagesToPrint: 1,
        color: 'BLACK_AND_WHITE',
        duplex: 'NONE',
        copies: 1,
        cost,
        status: 'PENDING_PAYMENT',
        pricingSnapshot: JSON.stringify({ sessionId, totalCost: cost })
      }
    });
  };

  // Preserve original axios.post/axios.get
  const origAxiosPost = axios.post;
  const origAxiosGet = axios.get;

  try {
    // 1. Demo payment blocked when ENABLE_DEMO_PAYMENT unset/false
    await test('1. Demo payment blocked by default when ENABLE_DEMO_PAYMENT is unset/false', async () => {
      const sess = `sess_demo_1_${suffix}`;
      const job = await createJob({ sessionId: sess });
      const token = makeSessionToken(sess, machineA.id);

      delete process.env.ENABLE_DEMO_PAYMENT;
      const res1 = await request(app)
        .post(`/api/payments/demo-pay/${job.shortId}`)
        .set('Authorization', `Bearer ${token}`)
        .send();
      if (res1.status !== 403) throw new Error(`Expected 403 when unset, got ${res1.status}`);

      process.env.ENABLE_DEMO_PAYMENT = 'false';
      const res2 = await request(app)
        .post(`/api/payments/demo-pay/${job.shortId}`)
        .set('Authorization', `Bearer ${token}`)
        .send();
      if (res2.status !== 403) throw new Error(`Expected 403 when false, got ${res2.status}`);
    });

    // 2. Demo payment blocked in production even if ENABLE_DEMO_PAYMENT=true
    await test('2. Demo payment permanently blocked when NODE_ENV=production', async () => {
      const sess = `sess_demo_prod_${suffix}`;
      const job = await createJob({ sessionId: sess });
      const token = makeSessionToken(sess, machineA.id);

      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      process.env.ENABLE_DEMO_PAYMENT = 'true';
      try {
        const res = await request(app)
          .post(`/api/payments/demo-pay/${job.shortId}`)
          .set('Authorization', `Bearer ${token}`)
          .send();
        if (res.status !== 403) throw new Error(`Expected 403 in production, got ${res.status}`);
      } finally {
        process.env.NODE_ENV = prevEnv;
        delete process.env.ENABLE_DEMO_PAYMENT;
      }
    });

    // 3. Demo payment blocked when unauthenticated or session does not own job
    await test('3. Demo payment requires auth & rejects cross-session / cross-machine callers', async () => {
      const ownerSess = `sess_owner_${suffix}`;
      const otherSess = `sess_attacker_${suffix}`;
      const job = await createJob({ sessionId: ownerSess });

      await ensureSession(otherSess, machineA);
      const wrongMachSess = `sess_wrong_machine_${suffix}`;
      await ensureSession(wrongMachSess, machineB);

      const stagingEnvSnapshot = {
        APP_ENV: process.env.APP_ENV,
        ENABLE_DEMO_PAYMENT: process.env.ENABLE_DEMO_PAYMENT,
        RENDER: process.env.RENDER,
        RENDER_SERVICE_ID: process.env.RENDER_SERVICE_ID,
        RENDER_SERVICE_NAME: process.env.RENDER_SERVICE_NAME,
        RENDER_GIT_BRANCH: process.env.RENDER_GIT_BRANCH,
        DEMO_PAYMENT_REQUIRE_ACCESS_CODE: process.env.DEMO_PAYMENT_REQUIRE_ACCESS_CODE
      };
      process.env.APP_ENV = 'staging';
      process.env.ENABLE_DEMO_PAYMENT = 'true';
      process.env.RENDER = 'true';
      process.env.RENDER_SERVICE_ID = 'srv-dbqpapon74is73csbc80';
      process.env.RENDER_SERVICE_NAME = 'printgo-backend-staging';
      process.env.RENDER_GIT_BRANCH = 'feature/printgo-production-readiness';
      process.env.DEMO_PAYMENT_REQUIRE_ACCESS_CODE = 'false';

      try {
        const unauthRes = await request(app).post(`/api/payments/demo-pay/${job.shortId}`).send();
        if (unauthRes.status !== 401) throw new Error(`Expected 401 unauthenticated, got ${unauthRes.status}`);

        const wrongSessToken = makeSessionToken(otherSess, machineA.id);
        const crossSessRes = await request(app)
          .post(`/api/payments/demo-pay/${job.shortId}`)
          .set('Authorization', `Bearer ${wrongSessToken}`)
          .send();
        if (crossSessRes.status !== 403) throw new Error(`Expected 403 cross-session, got ${crossSessRes.status}`);

        const wrongMachToken = makeSessionToken(wrongMachSess, machineB.id);
        const crossMachRes = await request(app)
          .post(`/api/payments/demo-pay/${job.shortId}`)
          .set('Authorization', `Bearer ${wrongMachToken}`)
          .send();
        if (crossMachRes.status !== 403) throw new Error(`Expected 403 cross-machine, got ${crossMachRes.status}`);

        // Owner session succeeds when explicitly opted in during non-prod
        const ownerToken = makeSessionToken(ownerSess, machineA.id);
        const okRes = await request(app)
          .post(`/api/payments/demo-pay/${job.shortId}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send();
        if (okRes.status !== 200 || okRes.body.job?.status !== 'WAITING') {
          throw new Error(`Expected owner demo-pay 200/WAITING, got ${okRes.status} (${JSON.stringify(okRes.body)})`);
        }
      } finally {
        for (const [key, value] of Object.entries(stagingEnvSnapshot)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    // 4. Verify endpoint requires valid session/user ownership
    await test('4. Payment verify endpoint requires valid session/user ownership', async () => {
      const ownerSess = `sess_ver_owner_${suffix}`;
      const otherSess = `sess_ver_other_${suffix}`;
      const job = await createJob({ sessionId: ownerSess });

      await ensureSession(otherSess, machineA);
      const wrongMachSess = `sess_ver_wrong_machine_${suffix}`;
      await ensureSession(wrongMachSess, machineB);

      const noAuth = await request(app).get(`/api/payments/verify/${job.shortId}`);
      if (noAuth.status !== 401) throw new Error(`Expected 401 without token, got ${noAuth.status}`);

      const crossSess = await request(app)
        .get(`/api/payments/verify/${job.shortId}`)
        .set('Authorization', `Bearer ${makeSessionToken(otherSess, machineA.id)}`);
      if (crossSess.status !== 403) throw new Error(`Expected 403 cross-session, got ${crossSess.status}`);

      const crossMach = await request(app)
        .get(`/api/payments/verify/${job.shortId}`)
        .set('Authorization', `Bearer ${makeSessionToken(wrongMachSess, machineB.id)}`);
      if (crossMach.status !== 403) throw new Error(`Expected 403 cross-machine, got ${crossMach.status}`);

      const validOwner = await request(app)
        .get(`/api/payments/verify/${job.shortId}`)
        .set('Authorization', `Bearer ${makeSessionToken(ownerSess, machineA.id)}`);
      if (validOwner.status !== 200 || validOwner.body.status !== 'NO_PAYMENT_INITIATED') {
        throw new Error(`Expected 200 NO_PAYMENT_INITIATED for owner, got ${validOwner.status}`);
      }
    });

    // 5. External returnUrl rejected; whitelisted origin accepted
    await test('5. Arbitrary external returnUrl rejected; whitelisted origin allowed', async () => {
      const sess = `sess_ret_${suffix}`;
      const job = await createJob({ sessionId: sess });
      const token = makeSessionToken(sess, machineA.id);

      const evilRes = await request(app)
        .post(`/api/payments/order/${job.shortId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ returnUrl: 'https://evil-phishing.example.com/steal?order_id={order_id}' });
      if (evilRes.status !== 400) {
        throw new Error(`Expected 400 for untrusted external returnUrl, got ${evilRes.status}`);
      }

      const jsRes = await request(app)
        .post(`/api/payments/order/${job.shortId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ returnUrl: 'javascript:alert(1)' });
      if (jsRes.status !== 400) {
        throw new Error(`Expected 400 for javascript: returnUrl, got ${jsRes.status}`);
      }

      axios.post = async (url, payload) => ({
        data: { order_id: payload.order_id, payment_session_id: `cf_sess_${payload.order_id}` }
      });

      const okRes = await request(app)
        .post(`/api/payments/order/${job.shortId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ returnUrl: `https://pilot.printgo.local/m/${sess}?order_id={order_id}` });
      if (okRes.status !== 200 || !okRes.body.orderId) {
        throw new Error(`Expected 200 for allowed returnUrl origin, got ${okRes.status}: ${JSON.stringify(okRes.body)}`);
      }
    });

    // 6. Payment retry integrity: delayed success webhook from earlier order resolves PrintJob
    await test('6. Payment retry preserves earlier Payment -> PrintJob link; delayed webhook succeeds cleanly once', async () => {
      dispatchCalls = [];
      const sess = `sess_retry_${suffix}`;
      const job = await createJob({ sessionId: sess, cost: 25 });
      const token = makeSessionToken(sess, machineA.id);

      let orderSeq = 1;
      axios.post = async (url, payload) => ({
        data: { order_id: payload.order_id, payment_session_id: `cf_sess_${orderSeq++}_${payload.order_id}` }
      });

      const res1 = await request(app)
        .post(`/api/payments/order/${job.shortId}`)
        .set('Authorization', `Bearer ${token}`)
        .send();
      if (res1.status !== 200) throw new Error(`Order 1 failed: ${res1.status}`);
      const orderId1 = res1.body.orderId;

      await new Promise(r => setTimeout(r, 15)); // guarantee distinct Date.now() suffix

      const res2 = await request(app)
        .post(`/api/payments/order/${job.shortId}`)
        .set('Authorization', `Bearer ${token}`)
        .send();
      if (res2.status !== 200) throw new Error(`Order 2 failed: ${res2.status}`);
      const orderId2 = res2.body.orderId;

      if (orderId1 === orderId2) throw new Error('Expected distinct order IDs for retries');

      // Verify PrintJob.paymentId currently points to Order 2
      const p1 = await prisma.payment.findUnique({ where: { gatewayOrderId: orderId1 } });
      const p2 = await prisma.payment.findUnique({ where: { gatewayOrderId: orderId2 } });
      const jobBefore = await prisma.printJob.findUnique({ where: { id: job.id } });
      if (jobBefore.paymentId !== p2.id) {
        throw new Error('Precondition check failed: expected job.paymentId to point to Order 2');
      }

      // Now simulate delayed PAYMENT_SUCCESS_WEBHOOK arriving for EARLIER Order 1!
      axios.get = async (url) => {
        if (url.endsWith('/payments')) {
          return { data: [{ cf_payment_id: 'cf_retry_111', payment_status: 'SUCCESS', payment_group: 'upi', payment_method: { upi: {} } }] };
        }
        return { data: { order_id: orderId1, order_status: 'PAID', order_amount: 25 } };
      };

      const webhookBody = JSON.stringify({
        event_id: `evt_retry_win_${suffix}`,
        type: 'PAYMENT_SUCCESS_WEBHOOK',
        data: { order: { order_id: orderId1 } }
      });
      const ts = Math.floor(Date.now() / 1000).toString();
      const sig = signWebhook(ts, webhookBody);

      const whRes = await request(app)
        .post('/api/payments/webhook')
        .set('x-webhook-timestamp', ts)
        .set('x-webhook-signature', sig)
        .set('Content-Type', 'application/json')
        .send(webhookBody);

      if (whRes.status !== 200) throw new Error(`Webhook status ${whRes.status}`);

      const jobAfter = await prisma.printJob.findUnique({ where: { id: job.id } });
      const p1After = await prisma.payment.findUnique({ where: { id: p1.id } });
      if (jobAfter.status !== 'WAITING') throw new Error(`Expected job status WAITING, got ${jobAfter.status}`);
      if (jobAfter.paymentId !== p1.id) throw new Error(`Expected winning paymentId ${p1.id}, got ${jobAfter.paymentId}`);
      if (p1After.status !== 'SUCCESS') throw new Error(`Expected Payment 1 SUCCESS, got ${p1After.status}`);
      if (dispatchCalls.filter(id => id === job.shortId).length !== 1) {
        throw new Error(`Expected exactly 1 print dispatch for ${job.shortId}, got ${dispatchCalls.length}`);
      }

      // Bonus check: 7. Multiple successful payments for the same job (Order 2 also captures later!)
      axios.get = async (url) => {
        if (url.endsWith('/payments')) {
          return { data: [{ cf_payment_id: 'cf_dup_222', payment_status: 'SUCCESS', payment_group: 'upi', payment_method: { upi: {} } }] };
        }
        return { data: { order_id: orderId2, order_status: 'PAID', order_amount: 25 } };
      };

      const dupBody = JSON.stringify({
        event_id: `evt_dup_capture_${suffix}`,
        type: 'PAYMENT_SUCCESS_WEBHOOK',
        data: { order: { order_id: orderId2 } }
      });
      const ts2 = Math.floor(Date.now() / 1000).toString();
      const dupRes = await request(app)
        .post('/api/payments/webhook/cashfree')
        .set('x-webhook-timestamp', ts2)
        .set('x-webhook-signature', signWebhook(ts2, dupBody))
        .set('Content-Type', 'application/json')
        .send(dupBody);
      if (dupRes.status !== 200) throw new Error(`Duplicate capture webhook failed: ${dupRes.status}`);

      // Print MUST NOT be dispatched twice!
      if (dispatchCalls.filter(id => id === job.shortId).length !== 1) {
        throw new Error(`DUPLICATE PRINT TRIGGERED! Dispatch count=${dispatchCalls.filter(id => id === job.shortId).length}`);
      }

      // Discrepancy must be flagged in both Transaction and ReconciliationRecord
      const dupTx = await prisma.transaction.findFirst({
        where: { paymentId: p2.id, action: 'DUPLICATE_PAYMENT_FOR_JOB' }
      });
      const dupRec = await prisma.reconciliationRecord.findFirst({
        where: { paymentId: p2.id, discrepancyType: 'DUPLICATE_PAYMENT_FOR_JOB', status: 'MANUAL_REVIEW_REQUIRED' }
      });
      if (!dupTx || !dupRec) {
        throw new Error(`Expected DUPLICATE_PAYMENT_FOR_JOB audit + ReconciliationRecord, got tx=${!!dupTx}, rec=${!!dupRec}`);
      }
    });

    // 8. Webhook invalid signature / expired timestamp / missing headers rejected
    await test('7. Invalid webhook signature, missing headers & expired timestamp rejected (401)', async () => {
      const body = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'order_fake' } } });
      const validTs = Math.floor(Date.now() / 1000).toString();
      const expiredTs = (Math.floor(Date.now() / 1000) - 1200).toString();

      const r1 = await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').send(body);
      if (r1.status !== 401) throw new Error(`Expected 401 missing headers, got ${r1.status}`);

      const r2 = await request(app)
        .post('/api/payments/webhook')
        .set('x-webhook-timestamp', validTs)
        .set('x-webhook-signature', 'bad_sig_base64==')
        .set('Content-Type', 'application/json')
        .send(body);
      if (r2.status !== 401) throw new Error(`Expected 401 invalid signature, got ${r2.status}`);

      const r3 = await request(app)
        .post('/api/payments/webhook')
        .set('x-webhook-timestamp', expiredTs)
        .set('x-webhook-signature', signWebhook(expiredTs, body))
        .set('Content-Type', 'application/json')
        .send(body);
      if (r3.status !== 401) throw new Error(`Expected 401 expired timestamp, got ${r3.status}`);
    });

    // 9. PAYMENT_USER_DROPPED_WEBHOOK & delayed failure protection + 10. Duplicate webhook idempotency
    await test('8. User dropped webhook marks PENDING->FAILED, never overwrites SUCCESS, and PaymentEvent dedups replays', async () => {
      const orderDrop = `order_drop_${suffix}`;
      const pPending = await prisma.payment.create({
        data: { amount: 15, currency: 'INR', status: 'PENDING', type: 'PRINT_JOB', gatewayOrderId: orderDrop }
      });

      const dropBody = JSON.stringify({
        event_id: `evt_drop_${suffix}`,
        type: 'PAYMENT_USER_DROPPED_WEBHOOK',
        data: { order: { order_id: orderDrop }, payment: { payment_message: 'Customer closed checkout' } }
      });
      const ts1 = Math.floor(Date.now() / 1000).toString();
      const res1 = await request(app)
        .post('/api/payments/webhook')
        .set('x-webhook-timestamp', ts1)
        .set('x-webhook-signature', signWebhook(ts1, dropBody))
        .set('Content-Type', 'application/json')
        .send(dropBody);
      if (res1.status !== 200) throw new Error(`Expected 200 on drop webhook, got ${res1.status}`);

      const pDropped = await prisma.payment.findUnique({ where: { id: pPending.id } });
      if (pDropped.status !== 'FAILED') throw new Error(`Expected FAILED after user drop, got ${pDropped.status}`);

      // Replay exact same event_id -> idempotent 'Already processed'
      const tsReplay = Math.floor(Date.now() / 1000).toString();
      const replayRes = await request(app)
        .post('/api/payments/webhook')
        .set('x-webhook-timestamp', tsReplay)
        .set('x-webhook-signature', signWebhook(tsReplay, dropBody))
        .set('Content-Type', 'application/json')
        .send(dropBody);
      if (replayRes.status !== 200 || replayRes.text !== 'Already processed') {
        throw new Error(`Expected 'Already processed' on duplicate event_id, got ${replayRes.status}/${replayRes.text}`);
      }

      // Now verify delayed PAYMENT_FAILED_WEBHOOK CANNOT overwrite SUCCESS payment
      const orderWon = `order_won_${suffix}`;
      const pWon = await prisma.payment.create({
        data: { amount: 20, currency: 'INR', status: 'SUCCESS', type: 'PRINT_JOB', gatewayOrderId: orderWon, paidAt: new Date() }
      });
      const lateFailBody = JSON.stringify({
        event_id: `evt_late_fail_${suffix}`,
        type: 'PAYMENT_FAILED_WEBHOOK',
        data: { order: { order_id: orderWon }, payment: { payment_message: 'Out-of-order attempt failure' } }
      });
      const ts2 = Math.floor(Date.now() / 1000).toString();
      await request(app)
        .post('/api/payments/webhook')
        .set('x-webhook-timestamp', ts2)
        .set('x-webhook-signature', signWebhook(ts2, lateFailBody))
        .set('Content-Type', 'application/json')
        .send(lateFailBody);

      const pWonAfter = await prisma.payment.findUnique({ where: { id: pWon.id } });
      if (pWonAfter.status !== 'SUCCESS') {
        throw new Error(`Late failure overwrote SUCCESS payment to ${pWonAfter.status}`);
      }
    });

    // 11. REFUND_STATUS_WEBHOOK updates Refund -> SUCCESS, Payment -> REFUNDED, and issues Credit Note
    await test('9. REFUND_STATUS_WEBHOOK updates refund, payment & issues Credit Note', async () => {
      const job = await createJob({ cost: 40 });
      const gwOrderId = `order_${job.shortId}_999`;
      const gwRefundId = `ref_${job.shortId}_999`;
      const payment = await prisma.payment.create({
        data: { amount: 40, currency: 'INR', status: 'SUCCESS', type: 'PRINT_JOB', gatewayOrderId: gwOrderId, paidAt: new Date() }
      });
      const paidJob = await prisma.printJob.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', paymentId: payment.id }
      });
      const invoice = await generateInvoiceForJob(paidJob.shortId);
      const refund = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          printJobId: paidJob.id,
          gatewayRefundId: gwRefundId,
          cfRefundId: `cf_ref_${suffix}`,
          amount: 40,
          reason: 'Paper jam test refund',
          status: 'PROCESSING',
          initiatedBy: superadmin.id
        }
      });

      const refBody = JSON.stringify({
        event_id: `evt_ref_wh_${suffix}`,
        type: 'REFUND_STATUS_WEBHOOK',
        data: {
          refund: {
            refund_id: gwRefundId,
            cf_refund_id: `cf_ref_${suffix}`,
            order_id: gwOrderId,
            refund_amount: 40,
            refund_status: 'SUCCESS'
          }
        }
      });
      const ts = Math.floor(Date.now() / 1000).toString();
      const whRes = await request(app)
        .post('/api/payments/webhook')
        .set('x-webhook-timestamp', ts)
        .set('x-webhook-signature', signWebhook(ts, refBody))
        .set('Content-Type', 'application/json')
        .send(refBody);

      if (whRes.status !== 200) throw new Error(`Refund webhook status ${whRes.status}`);

      const refAfter = await prisma.refund.findUnique({ where: { id: refund.id } });
      const payAfter = await prisma.payment.findUnique({ where: { id: payment.id } });
      const cn = await prisma.creditNote.findFirst({ where: { invoiceId: invoice.id, refundId: refund.id } });
      if (refAfter.status !== 'SUCCESS') throw new Error(`Expected refund SUCCESS, got ${refAfter.status}`);
      if (payAfter.status !== 'REFUNDED') throw new Error(`Expected payment REFUNDED, got ${payAfter.status}`);
      if (!cn) throw new Error('Expected statutory CreditNote to be issued on REFUND_STATUS_WEBHOOK');
    });

    // 12. Unified refund endpoint shares idempotency + Credit Note + tenant check
    await test('10. Unified /api/payments/refund/:id enforces tenancy, idempotency & Credit Note', async () => {
      const job = await createJob({ machine: machineA, cost: 30 });
      const gwOrderId = `order_${job.shortId}_uni`;
      const payment = await prisma.payment.create({
        data: { amount: 30, currency: 'INR', status: 'SUCCESS', type: 'PRINT_JOB', gatewayOrderId: gwOrderId, paidAt: new Date() }
      });
      await prisma.printJob.update({
        where: { id: job.id },
        // Refund endpoint covers pre-fulfillment failures; completed physical jobs are intentionally non-refundable.
        data: { status: 'WAITING', paymentId: payment.id }
      });
      const invoice = await generateInvoiceForJob(job.shortId);

      let refundGatewayCalls = 0;
      cashfreeGateway.setMockMode(true, {
        createRefund: async ({ refundId, amount }) => {
          refundGatewayCalls++;
          return {
            success: true,
            status: 'SUCCESS',
            cfRefundId: `cf_uni_${refundGatewayCalls}`,
            refundId,
            amount,
            rawResponse: { refund_status: 'SUCCESS' }
          };
        }
      });

      const franB = await prisma.user.create({
        data: {
          email: `franB_${suffix}@test.local`,
          password: 'hashed_password_placeholder',
          name: 'Franchisee B',
          role: 'FRANCHISEE',
          companyId: companyB.id
        }
      });

      try {
        // Cross-company franchisee B must get 403
        const resForbidden = await request(app)
          .post(`/api/payments/refund/${job.shortId}`)
          .set('Authorization', `Bearer ${makeUserToken(franB.id)}`)
          .send({ reason: 'Cross tenant refund test' });
        if (resForbidden.status !== 403) throw new Error(`Expected 403 cross-tenant refund, got ${resForbidden.status}`);

        // Authorized franchisee A triggers refund
        const res1 = await request(app)
          .post(`/api/payments/refund/${job.shortId}`)
          .set('Authorization', `Bearer ${makeUserToken(franchiseeA.id)}`)
          .send({ reason: 'Authorized owner refund', idempotencyKey: `idem_uni_${suffix}` });
        if (res1.status !== 200 || res1.body.refund?.status !== 'SUCCESS') {
          throw new Error(`Expected unified refund 200/SUCCESS, got ${res1.status}: ${JSON.stringify(res1.body)}`);
        }

        // Repeat with same idempotencyKey -> must NOT call gateway again
        const res2 = await request(app)
          .post(`/api/payments/refund/${job.shortId}`)
          .set('Authorization', `Bearer ${makeUserToken(franchiseeA.id)}`)
          .send({ reason: 'Authorized owner refund', idempotencyKey: `idem_uni_${suffix}` });
        if (res2.status !== 200 || refundGatewayCalls !== 1) {
          throw new Error(`Expected idempotent refund (gateway calls=1), got calls=${refundGatewayCalls}`);
        }

        const cn = await prisma.creditNote.findFirst({ where: { invoiceId: invoice.id } });
        if (!cn) throw new Error('Expected unified refund endpoint to issue CreditNote via refund.service');
      } finally {
        cashfreeGateway.setMockMode(false);
        await prisma.user.delete({ where: { id: franB.id } }).catch(() => {});
      }
    });

    // 13. Environment safety: mismatched CASHFREE_ENV vs key prefixes fails closed
    await test('11. Cashfree env standardization & key mismatch fail closed safely', async () => {
      const snap = {
        CASHFREE_ENV: process.env.CASHFREE_ENV,
        CASHFREE_ENVIRONMENT: process.env.CASHFREE_ENVIRONMENT,
        CASHFREE_APP_ID: process.env.CASHFREE_APP_ID,
        CASHFREE_SECRET_KEY: process.env.CASHFREE_SECRET_KEY
      };
      try {
        process.env.CASHFREE_ENV = 'production';
        delete process.env.CASHFREE_ENVIRONMENT;
        process.env.CASHFREE_APP_ID = 'MOCK_SANDBOX_1';
        process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_should_block_in_prod';
        const v1 = validateCashfreeConfig();
        if (v1.isValid || v1.environment !== 'ENV_MISMATCH') {
          throw new Error(`Expected ENV_MISMATCH for test key in prod, got ${JSON.stringify(v1)}`);
        }

        process.env.CASHFREE_ENV = 'sandbox';
        process.env.CASHFREE_APP_ID = 'APP_12345';
        process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_prod_should_block_in_sandbox';
        const v2 = validateCashfreeConfig();
        if (v2.isValid || v2.environment !== 'ENV_MISMATCH') {
          throw new Error(`Expected ENV_MISMATCH for prod key in sandbox, got ${JSON.stringify(v2)}`);
        }

        process.env.CASHFREE_ENV = 'sandbox';
        process.env.CASHFREE_ENVIRONMENT = 'PROD';
        process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_ok';
        const v3 = validateCashfreeConfig();
        if (v3.isValid || v3.environment !== 'INVALID_ENV') {
          throw new Error(`Expected INVALID_ENV on conflicting env vars, got ${JSON.stringify(v3)}`);
        }

        // Substring 'prod' in sandbox URL/metadata or secret suffix no longer accidentally switches mode
        process.env.CASHFREE_ENV = 'sandbox';
        delete process.env.CASHFREE_ENVIRONMENT;
        process.env.CASHFREE_APP_ID = 'MOCK_SANDBOX_1';
        process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_nonprod_key';
        const v4 = validateCashfreeConfig();
        if (!v4.isValid || v4.environment !== 'SANDBOX' || v4.isProduction !== false) {
          throw new Error(`Expected valid SANDBOX, got ${JSON.stringify(v4)}`);
        }
      } finally {
        Object.assign(process.env, snap);
        if (!snap.CASHFREE_ENVIRONMENT) delete process.env.CASHFREE_ENVIRONMENT;
      }
    });

    // 14. Socket payment_success cannot mutate PrintJob or trigger print queue
    await test('12. Socket payment_success handler cannot trigger print dispatch or modify job status', async () => {
      const fs = require('fs');
      const path = require('path');
      const socketSrc = fs.readFileSync(path.resolve(__dirname, '../src/socket.js'), 'utf8');
      const match = socketSrc.match(/socket\.on\('payment_success'[\s\S]*?\n\s{4}\}\);/);
      if (!match) throw new Error('Could not locate payment_success handler in socket.js');
      const handlerBody = match[0];
      if (handlerBody.includes('startPrintingProcess') || handlerBody.includes('printJob.update') || handlerBody.includes('WAITING')) {
        throw new Error('SECURITY: socket payment_success handler references print dispatch or DB job transition');
      }

      // Also verify queueService crash recovery invokes refund.service directly rather than bypassing it
      const queueSrc = fs.readFileSync(path.resolve(__dirname, '../src/services/queueService.js'), 'utf8');
      if (!queueSrc.includes("require('./refund.service')") || !queueSrc.includes('auto_recovery_')) {
        throw new Error('Expected queueService crash recovery to route refunds via refund.service.createRefund with idempotency');
      }
    });
  } finally {
    axios.post = origAxiosPost;
    axios.get = origAxiosGet;

    // Clean up only records created by this test run cleanly
    const createdJobs = await prisma.printJob.findMany({
      where: { machineId: { in: [machineA.id, machineB.id] } },
      select: { id: true, paymentId: true }
    });
    const jobIds = createdJobs.map(j => j.id);
    await prisma.creditNote.deleteMany({ where: { invoice: { printJobId: { in: jobIds } } } }).catch(() => {});
    await prisma.invoice.deleteMany({ where: { printJobId: { in: jobIds } } }).catch(() => {});
    await prisma.reconciliationRecord.deleteMany({ where: { printJobId: { in: jobIds } } }).catch(() => {});
    await prisma.refund.deleteMany({ where: { printJobId: { in: jobIds } } }).catch(() => {});
    await prisma.printJob.deleteMany({ where: { id: { in: jobIds } } }).catch(() => {});
    if (createdSessionIds.size > 0) {
      await prisma.session.deleteMany({ where: { id: { in: [...createdSessionIds.values()] } } }).catch(() => {});
    }
    await prisma.paymentEvent.deleteMany({ where: { eventId: { contains: String(suffix) } } }).catch(() => {});
    await prisma.transaction.deleteMany({ where: { payment: { gatewayOrderId: { contains: String(suffix) } } } }).catch(() => {});
    await prisma.payment.deleteMany({
      where: {
        OR: [
          { gatewayOrderId: { contains: String(suffix) } },
          { id: { in: createdJobs.map(j => j.paymentId).filter(Boolean) } }
        ]
      }
    }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [franchiseeA.id, superadmin.id] } } }).catch(() => {});
    await prisma.machine.deleteMany({ where: { id: { in: [machineA.id, machineB.id] } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: [companyA.id, companyB.id] } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { id: doc.id } }).catch(() => {});
  }

  console.log('\n======================================================================');
  console.log(`BATCH 1 TEST SUITE RESULTS: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('======================================================================\n');

  if (failed > 0) process.exit(1);
}

runBatch1Suite()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('Fatal error in Batch 1 test suite:', err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
