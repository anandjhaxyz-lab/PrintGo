/**
 * S3K PrintGo - Batch 2 Backend Support, Security & Invoice Isolation Tests
 * Executes against printgo_disposable_target:5433 ONLY (never printgo_db, never live Cashfree, never physical printer).
 */

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { PDFDocument } = require('pdf-lib');

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
    throw new Error(`SAFETY ABORT: DB='${dbName}' port='${parsed.port}'`);
  }
};

assertDisposableDb();

process.env.JWT_SECRET = process.env.JWT_SECRET || 'batch2_test_jwt_secret_key_for_disposable_only';
process.env.NODE_ENV = 'test';
process.env.CASHFREE_ENV = 'sandbox';
delete process.env.CASHFREE_ENVIRONMENT;
process.env.CASHFREE_APP_ID = 'MOCK_SANDBOX_APP_BATCH2';
process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_batch2_verification_secret_key';
process.env.FRONTEND_URL = 'https://pilot.printgo.local';
process.env.PUBLIC_APP_URL = 'https://pilot.printgo.local';
delete process.env.ENABLE_DEMO_PAYMENT;

const prisma = require('../src/utils/prisma');
const queueService = require('../src/services/queueService');
const { getCashfreeConfig } = require('../src/config/cashfree.config');

// Guarantee zero real printer dispatch
const dispatchCalls = [];
queueService.startPrintingProcess = (shortId) => {
  dispatchCalls.push(shortId);
};

const authRoutes = require('../src/modules/auth/auth.routes');
const uploadRoutes = require('../src/modules/upload/upload.routes');
const jobsRoutes = require('../src/modules/jobs/jobs.routes');
const paymentsRoutes = require('../src/modules/payments/payments.routes');
const { errorHandler } = require('../src/middlewares/error');

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));
app.use(cookieParser());
app.set('io', { to: () => ({ emit: () => {} }), emit: () => {} });
app.use('/api/auth', authRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use(errorHandler);

const created = {
  machineIds: [],
  qrIds: [],
  sessionCodes: [],
  docIds: [],
  jobShortIds: [],
  jobIds: [],
  paymentIds: [],
  pricingProfileIds: [],
};

const origAxiosPost = axios.post;
const origAxiosGet = axios.get;

const createMinimalPdfBuffer = async (pageCount = 1) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([200, 200]);
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
};

const run = async () => {
  let passed = 0;
  let failed = 0;
  const results = [];

  const test = async (name, fn) => {
    try {
      await fn();
      passed += 1;
      results.push({ name, ok: true });
      console.log(`PASS: ${name}`);
    } catch (err) {
      failed += 1;
      results.push({ name, ok: false, error: err.message });
      console.error(`FAIL: ${name}\n  -> ${err.stack || err.message}`);
    }
  };

  // Fixture setup: disposable machine, QR, pricing profile
  const company = await prisma.company.findFirst();
  assert(company, 'Expected seed company in disposable DB');

  const uid = `b2_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const machine = await prisma.machine.create({
    data: {
      companyId: company.id,
      machineKey: `mk_${uid}`,
      name: `Batch2 Test Printer ${uid}`,
      location: 'Counter Desk A',
      printerModel: 'EPSON L6460 Series',
      status: 'ACTIVE',
    }
  });
  created.machineIds.push(machine.id);

  const qrPublicCode = `qr_${uid}`;
  const qr = await prisma.printerQr.create({
    data: {
      publicCode: qrPublicCode,
      label: 'Batch2 Counter QR',
      machineId: machine.id,
      status: 'ACTIVE',
    }
  });
  created.qrIds.push(qr.id);

  const profile = await prisma.printPricingProfile.create({
    data: {
      name: `Batch2 Profile ${uid}`,
      machineId: machine.id,
      bwSingleRate: 3.0,
      bwDuplexRate: 5.0,
      colorSingleRate: 12.0,
      colorDuplexRate: 20.0,
      convenienceFee: 2.0,
      minOrderAmount: 5.0,
      gstEnabled: true,
      gstRatePercent: 18.0,
      isTaxInclusive: true,
      isActive: true,
      isDefault: false,
    }
  });
  created.pricingProfileIds.push(profile.id);

  let sessionAToken = null;
  let sessionACode = null;
  let sessionBToken = null;
  let jobShortIdA = null;
  let orderIdA = null;

  try {
    await test('B2.1 QR resolution & public pricing endpoint return sanitized pricingProfile + sandbox mode without secrets', async () => {
      const qrRes = await request(app)
        .post('/api/auth/session/from-printer-qr')
        .send({ publicCode: qrPublicCode });

      assert.strictEqual(qrRes.status, 200);
      assert.strictEqual(qrRes.body.success, true);
      assert(qrRes.body.sessionToken, 'Expected sessionToken');
      assert(qrRes.body.expiresAt, 'Expected expiresAt');
      assert.strictEqual(qrRes.body.cashfreeEnv, 'sandbox');
      assert.strictEqual(qrRes.body.pricingProfile.bwSingleRate, 3);
      assert.strictEqual(qrRes.body.pricingProfile.colorSingleRate, 12);
      assert.strictEqual(qrRes.body.pricingProfile.convenienceFee, 2);
      assert.strictEqual(qrRes.body.pricingProfile.gstEnabled, true);
      assert.strictEqual(JSON.stringify(qrRes.body).includes('cfsk_ma_test'), false, 'Must NEVER leak Cashfree secret');

      sessionAToken = qrRes.body.sessionToken;
      sessionACode = qrRes.body.sessionCode;
      created.sessionCodes.push(sessionACode);

      // Second independent customer scanning same printer QR gets distinct isolated session
      const qrRes2 = await request(app)
        .post('/api/auth/session/from-printer-qr')
        .send({ publicCode: qrPublicCode });
      assert.strictEqual(qrRes2.status, 200);
      sessionBToken = qrRes2.body.sessionToken;
      created.sessionCodes.push(qrRes2.body.sessionCode);

      const pricingRes = await request(app)
        .get('/api/auth/pricing')
        .query({ publicCode: qrPublicCode });
      assert.strictEqual(pricingRes.status, 200);
      assert.strictEqual(pricingRes.body.pricingProfile.bwDuplexRate, 5);
      assert.strictEqual(pricingRes.body.cashfreeEnv, 'sandbox');
    });

    await test('B2.2 Upload route rejects Office (.docx/.pptx/.txt) & spoofed octet-stream, accepts valid PDF', async () => {
      const docxRes = await request(app)
        .post('/api/upload')
        .set('Authorization', `Bearer ${sessionAToken}`)
        .attach('file', Buffer.from('fake docx content'), {
          filename: 'resume.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });
      assert.strictEqual(docxRes.status, 400);

      const spoofedRes = await request(app)
        .post('/api/upload')
        .set('Authorization', `Bearer ${sessionAToken}`)
        .attach('file', Buffer.from('fake office bytes'), {
          filename: 'slides.pptx',
          contentType: 'application/octet-stream'
        });
      assert.strictEqual(spoofedRes.status, 400);

      const pdfBuf = await createMinimalPdfBuffer(2);
      const pdfRes = await request(app)
        .post('/api/upload')
        .set('Authorization', `Bearer ${sessionAToken}`)
        .attach('file', pdfBuf, {
          filename: 'batch2_sample.pdf',
          contentType: 'application/pdf'
        });
      assert.strictEqual(pdfRes.status, 200);
      assert.strictEqual(pdfRes.body.success, true);
      assert.strictEqual(pdfRes.body.file.pages, 2);
    });

    await test('B2.3 Job creation calculates authoritative profile cost & demo-pay stays disabled (403) without explicit flag', async () => {
      const pdfBuf = await createMinimalPdfBuffer(2);
      const upRes = await request(app)
        .post('/api/upload')
        .set('Authorization', `Bearer ${sessionAToken}`)
        .attach('file', pdfBuf, {
          filename: 'billable.pdf',
          contentType: 'application/pdf'
        });
      assert.strictEqual(upRes.status, 200);

      const jobRes = await request(app)
        .post('/api/jobs')
        .set('Authorization', `Bearer ${sessionAToken}`)
        .send({
          file: upRes.body.file,
          settings: {
            color: 'bw',
            duplex: 'single',
            copies: 1,
            pageRangeType: 'all',
            pagesToPrint: 2
          }
        });

      assert.strictEqual(jobRes.status, 200);
      assert.strictEqual(jobRes.body.success, true);
      const job = jobRes.body.job;
      jobShortIdA = job.shortId;
      created.jobShortIds.push(jobShortIdA);
      created.jobIds.push(job.id);
      if (job.documentId) created.docIds.push(job.documentId);

      // 2 pages * ₹3/page + ₹2 convenience = ₹8
      assert.strictEqual(job.cost, 8);
      assert.strictEqual(job.status, 'PENDING_PAYMENT');

      const demoAttempt = await request(app)
        .post(`/api/payments/demo-pay/${jobShortIdA}`)
        .set('Authorization', `Bearer ${sessionAToken}`)
        .send({});
      assert.strictEqual(demoAttempt.status, 403);
    });

    await test('B2.4 Cashfree Sandbox order creation + unverified client/failed poll cannot dispatch; retry preserves history; server verify unlocks queue + invoice', async () => {
      const cfConfig = getCashfreeConfig();
      assert.strictEqual(cfConfig.validation.environment, 'SANDBOX');

      let orderSeq = 0;
      axios.post = async (url) => {
        if (String(url).includes('/orders')) {
          orderSeq += 1;
          return {
            data: {
              order_id: `order_${jobShortIdA}_mock_${orderSeq}`,
              payment_session_id: `session_${uid}_${orderSeq}`
            }
          };
        }
        return origAxiosPost.apply(axios, arguments);
      };

      // Attempt 1: Create Cashfree Sandbox order
      const ord1 = await request(app)
        .post(`/api/payments/order/${jobShortIdA}`)
        .set('Authorization', `Bearer ${sessionAToken}`)
        .send({ returnUrl: 'https://pilot.printgo.local/p/' + qrPublicCode });
      assert.strictEqual(ord1.status, 200);
      assert.strictEqual(ord1.body.environment, 'SANDBOX');
      const firstOrderId = ord1.body.orderId;

      // Simulate USER_DROPPED on Attempt 1
      axios.get = async (url) => {
        if (String(url).includes(firstOrderId)) {
          return {
            data: {
              order_id: firstOrderId,
              order_status: 'ACTIVE',
              order_amount: 8
            }
          };
        }
        return origAxiosGet.apply(axios, arguments);
      };

      const vPending = await request(app)
        .get(`/api/payments/verify/${firstOrderId}`)
        .set('Authorization', `Bearer ${sessionAToken}`);
      assert.strictEqual(vPending.status, 200);
      assert.strictEqual(vPending.body.success, false);
      assert.strictEqual(dispatchCalls.includes(jobShortIdA), false, 'Pending payment must never dispatch');

      // Attempt 2: Retry creates second Payment attempt cleanly without destroying Payment #1
      const ord2 = await request(app)
        .post(`/api/payments/order/${jobShortIdA}`)
        .set('Authorization', `Bearer ${sessionAToken}`)
        .send({ returnUrl: 'https://pilot.printgo.local/p/' + qrPublicCode });
      assert.strictEqual(ord2.status, 200);
      orderIdA = ord2.body.orderId;
      assert.notStrictEqual(orderIdA, firstOrderId);

      // Simulate Cashfree PAID response for Attempt 2
      axios.get = async (url) => {
        if (String(url).includes(orderIdA) && url.endsWith('/payments')) {
          return {
            data: [
              {
                cf_payment_id: `cf_b2_${Date.now()}`,
                payment_status: 'SUCCESS',
                payment_amount: 8,
                payment_group: 'upi'
              }
            ]
          };
        }
        if (String(url).includes(orderIdA)) {
          return {
            data: {
              order_id: orderIdA,
              order_status: 'PAID',
              order_amount: 8
            }
          };
        }
        return origAxiosGet.apply(axios, arguments);
      };

      const vSuccess = await request(app)
        .get(`/api/payments/verify/${orderIdA}`)
        .set('Authorization', `Bearer ${sessionAToken}`);
      assert.strictEqual(vSuccess.status, 200);
      assert.strictEqual(vSuccess.body.success, true);
      assert.strictEqual(vSuccess.body.job.status, 'WAITING');
      assert.strictEqual(dispatchCalls.filter((id) => id === jobShortIdA).length, 1, 'Expected single queue dispatch');

      // Duplicate verify / replay idempotency
      const vReplay = await request(app)
        .get(`/api/payments/verify/${orderIdA}`)
        .set('Authorization', `Bearer ${sessionAToken}`);
      assert.strictEqual(vReplay.status, 200);
      assert.strictEqual(dispatchCalls.filter((id) => id === jobShortIdA).length, 1, 'Replay verify must not double-dispatch');

      const allPayments = await prisma.payment.findMany({
        where: { gatewayOrderId: { in: [firstOrderId, orderIdA] } }
      });
      allPayments.forEach((p) => created.paymentIds.push(p.id));
      assert.strictEqual(allPayments.length, 2, 'Retry must preserve prior payment attempt record');
    });

    await test('B2.5 Cross-session invoice & PDF isolation blocks Session B on same printer while allowing owning Session A', async () => {
      // Session B on the exact same machine MUST NOT see Session A invoice or download PDF
      const bMeta = await request(app)
        .get(`/api/jobs/${jobShortIdA}/invoice`)
        .set('Authorization', `Bearer ${sessionBToken}`);
      assert.strictEqual(bMeta.status, 404);

      const bPdf = await request(app)
        .get(`/api/jobs/${jobShortIdA}/invoice/download`)
        .set('Authorization', `Bearer ${sessionBToken}`);
      assert.strictEqual(bPdf.status, 404);

      // Owning Session A succeeds cleanly
      const aMeta = await request(app)
        .get(`/api/jobs/${jobShortIdA}/invoice`)
        .set('Authorization', `Bearer ${sessionAToken}`);
      assert.strictEqual(aMeta.status, 200);
      assert.strictEqual(aMeta.body.success, true);
      assert(aMeta.body.invoice.invoiceNumber, 'Expected generated invoiceNumber');

      const aPdf = await request(app)
        .get(`/api/jobs/${jobShortIdA}/invoice/download`)
        .set('Authorization', `Bearer ${sessionAToken}`);
      assert.strictEqual(aPdf.status, 200);
      assert(String(aPdf.headers['content-type']).includes('pdf'), 'Expected PDF content-type');
    });
  } finally {
    axios.post = origAxiosPost;
    axios.get = origAxiosGet;

    // Clean up only Batch 2 disposable test artifacts
    if (created.jobIds.length > 0) {
      await prisma.invoice.deleteMany({ where: { printJobId: { in: created.jobIds } } }).catch(() => {});
      await prisma.printJob.deleteMany({ where: { id: { in: created.jobIds } } }).catch(() => {});
    }
    if (created.jobShortIds.length > 0) {
      const stalePayments = await prisma.payment.findMany({
        where: { OR: created.jobShortIds.map((sid) => ({ gatewayOrderId: { startsWith: `order_${sid}_` } })) },
        select: { id: true }
      }).catch(() => []);
      stalePayments.forEach((p) => created.paymentIds.push(p.id));
    }
    if (created.paymentIds.length > 0) {
      const uniqPaymentIds = [...new Set(created.paymentIds)];
      await prisma.transaction.deleteMany({ where: { paymentId: { in: uniqPaymentIds } } }).catch(() => {});
      await prisma.payment.deleteMany({ where: { id: { in: uniqPaymentIds } } }).catch(() => {});
    }
    if (created.docIds.length > 0) {
      await prisma.document.deleteMany({ where: { id: { in: created.docIds } } }).catch(() => {});
    }
    if (created.sessionCodes.length > 0) {
      await prisma.session.deleteMany({ where: { code: { in: created.sessionCodes } } }).catch(() => {});
    }
    if (created.qrIds.length > 0) {
      await prisma.printerQr.deleteMany({ where: { id: { in: created.qrIds } } }).catch(() => {});
    }
    if (created.pricingProfileIds.length > 0) {
      await prisma.printPricingProfile.deleteMany({ where: { id: { in: created.pricingProfileIds } } }).catch(() => {});
    }
    if (created.machineIds.length > 0) {
      await prisma.machine.deleteMany({ where: { id: { in: created.machineIds } } }).catch(() => {});
    }

    await prisma.$disconnect();
  }

  console.log(`\nBATCH 2 BACKEND SUMMARY: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
};

run().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
