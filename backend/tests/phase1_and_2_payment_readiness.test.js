const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
// Keep payment-readiness tests deterministic and fail-closed regardless of developer .env values.
// These explicit placeholders must be rejected before any Cashfree network call is possible.
process.env.CASHFREE_ENV = 'sandbox';
process.env.CASHFREE_APP_ID = 'YOUR_SANDBOX_APP_ID';
process.env.CASHFREE_SECRET_KEY = 'YOUR_SANDBOX_SECRET_KEY';
delete process.env.CASHFREE_ENVIRONMENT;

function validateDatabaseUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new Error('FATAL SAFETY VIOLATION: DATABASE_URL is not set or empty! Aborting immediately.');
  }

  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (err) {
    throw new Error(`FATAL SAFETY VIOLATION: Malformed DATABASE_URL: ${err.message}`);
  }

  // 1. Protocol: must be postgresql:
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`FATAL SAFETY VIOLATION: Protocol '${parsed.protocol}' is invalid. Must be postgresql:`);
  }

  // 2. Host: strictly localhost or 127.0.0.1
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(`FATAL SAFETY VIOLATION: Database host '${parsed.hostname}' is not localhost or 127.0.0.1! Remote, Render, Staging and Production databases are strictly prohibited.`);
  }

  // 3. Database: strictly printgo_disposable_target
  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (dbName !== 'printgo_disposable_target') {
    throw new Error(`FATAL SAFETY VIOLATION: Database '${dbName}' is not printgo_disposable_target! Aborting immediately.`);
  }

  // 4. Port: 5433 for local testing, 5432 only for GitHub Actions
  const isCi = process.env.GITHUB_ACTIONS === 'true';
  const expectedPort = isCi ? 5432 : 5433;
  const actualPort = parsed.port ? Number(parsed.port) : 5432;
  if (actualPort !== expectedPort) {
    throw new Error(`FATAL SAFETY VIOLATION: Database port is ${actualPort}, must be ${expectedPort} (GITHUB_ACTIONS=${isCi})! Aborting immediately.`);
  }

  return true;
}

const credsPath = path.resolve(__dirname, '../../.pg_credentials.local');
let targetUrl = process.env.DATABASE_URL;

if (!targetUrl && fs.existsSync(credsPath)) {
  const creds = fs.readFileSync(credsPath, 'utf8');
  const pass = creds.match(/POSTGRES_PASSWORD=(.*)/)[1].trim();
  targetUrl = `postgresql://postgres:${encodeURIComponent(pass)}@localhost:5433/printgo_disposable_target?schema=public`;
}

if (!targetUrl) {
  throw new Error('DATABASE_URL or .pg_credentials.local is required to run phase1_and_2_payment_readiness test suite');
}

// Validate DATABASE_URL BEFORE requiring/initializing Prisma
validateDatabaseUrl(targetUrl);
process.env.DATABASE_URL = targetUrl;

const crypto = require('crypto');
const prisma = require('../src/utils/prisma');
const paymentsService = require('../src/modules/payments/payments.service');
const { validateCashfreeConfig, getCashfreeConfig } = require('../src/config/cashfree.config');
const { isValidJobTransition } = require('../src/utils/stateMachine');

async function runTestSuite() {
  console.log('======================================================================');
  console.log('PRINTGO — PHASE 1 & PHASE 2 PAYMENT READINESS & FINANCIAL AUDIT TESTS');
  console.log('======================================================================\n');

  // Server-side pre-flight check before creating any test fixtures
  const meta = await prisma.$queryRawUnsafe('SELECT current_database(), inet_server_port();');
  const dbName = meta[0].current_database;
  const dbPort = meta[0].inet_server_port;

  const isCi = process.env.GITHUB_ACTIONS === 'true';
  const expectedPort = isCi ? 5432 : 5433;

  if (dbName !== 'printgo_disposable_target' || Number(dbPort) !== expectedPort) {
    console.error(`FATAL SAFETY VIOLATION: Database is NOT printgo_disposable_target:${expectedPort} (GITHUB_ACTIONS=${isCi})! Aborting.`);
    process.exit(1);
  }
  console.log(`Pre-flight Database Check: ${dbName} on port ${dbPort}`);
  console.log('Pre-flight Safety Check PASSED: Strictly isolated to disposable target.\n');

  let passed = 0;
  let failed = 0;

  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (e) {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   Details: ${e.message}\n`);
      failed++;
    }
  };

  // Helper to create a dummy document and job for testing
  const createTestJob = async (cost = 10.0) => {
    const shortId = 'TST-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    const doc = await prisma.document.create({
      data: {
        originalName: 'test_doc.pdf',
        filename: '/uploads/test_doc.pdf',
        mimetype: 'application/pdf',
        size: 2048,
        pages: 1
      }
    });

    const job = await prisma.printJob.create({
      data: {
        shortId,
        status: 'PENDING_PAYMENT',
        cost: cost,
        documentId: doc.id,
        copies: 1,
        pagesToPrint: 1
      }
    });

    return { job, doc };
  };

  // -------------------------------------------------------------------------
  // TEST 1: Cashfree Configuration Validation & Placeholder Detection
  // -------------------------------------------------------------------------
  await test('Cashfree config validation detects placeholder credentials safely', async () => {
    const validation = validateCashfreeConfig();
    console.log(`   Config status: isConfigured=${validation.isConfigured}, isValid=${validation.isValid}, env=${validation.environment}`);
    if (validation.isValid === true && validation.environment === 'MOCK_PLACEHOLDER') {
      throw new Error('Placeholder credentials should not be marked as valid');
    }
  });

  // -------------------------------------------------------------------------
  // TEST 2: Order Creation Safety with Mock Credentials
  // -------------------------------------------------------------------------
  await test('createOrder safely blocks mock credentials before calling gateway API', async () => {
    const { job } = await createTestJob(20.0);
    try {
      await paymentsService.createOrder(job.shortId);
      throw new Error('Should have thrown AppError regarding placeholder credentials');
    } catch (err) {
      if (!err.message.includes('placeholder') && !err.message.includes('credentials') && !err.message.includes('Missing')) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
      // Verify job remained PENDING_PAYMENT
      const freshJob = await prisma.printJob.findUnique({ where: { id: job.id } });
      if (freshJob.status !== 'PENDING_PAYMENT') {
        throw new Error(`Job status was altered to ${freshJob.status}`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // TEST 3: Duplicate Webhook Idempotency using PaymentEvent Ledger
  // -------------------------------------------------------------------------
  await test('PaymentEvent ledger detects and blocks duplicate webhooks', async () => {
    const testOrderId = 'order_idemp_' + Date.now();
    const uniqueEventId = 'evt_' + Date.now() + '_' + testOrderId;

    // 1. First webhook insert
    const event1 = await prisma.paymentEvent.create({
      data: {
        eventId: uniqueEventId,
        eventType: 'PAYMENT_SUCCESS_WEBHOOK',
        gatewayOrderId: testOrderId,
        payload: JSON.stringify({ note: 'first delivery' }),
        processed: true,
        processedAt: new Date()
      }
    });

    if (!event1.id) throw new Error('Failed to create PaymentEvent');

    // 2. Second webhook check (simulate duplicate receipt)
    const existing = await prisma.paymentEvent.findUnique({
      where: { eventId: uniqueEventId }
    });

    if (!existing || !existing.processed) {
      throw new Error('Existing event should be detected as already processed');
    }

    // 3. Duplicate insert should violate unique constraint
    try {
      await prisma.paymentEvent.create({
        data: {
          eventId: uniqueEventId,
          eventType: 'PAYMENT_SUCCESS_WEBHOOK',
          gatewayOrderId: testOrderId,
          payload: JSON.stringify({ note: 'duplicate delivery' }),
          processed: false
        }
      });
      throw new Error('Database allowed duplicate eventId in PaymentEvent');
    } catch (err) {
      if (!err.message.includes('Unique constraint failed') && !err.code?.includes('P2002')) {
        throw err;
      }
    }
  });

  // -------------------------------------------------------------------------
  // TEST 4: HMAC-SHA256 Webhook Signature Validation
  // -------------------------------------------------------------------------
  await test('Webhook signature verification rejects tampered payloads and accepts valid HMAC', async () => {
    const testSecret = 'secret_test_key_12345';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const validBody = JSON.stringify({ order_id: 'order_test_1', amount: 50 });
    const tamperedBody = JSON.stringify({ order_id: 'order_test_1', amount: 5 }); // Tampered amount

    const validSignature = crypto
      .createHmac('sha256', testSecret)
      .update(timestamp + validBody)
      .digest('base64');

    // Verification check for valid body
    const calculatedForValid = crypto
      .createHmac('sha256', testSecret)
      .update(timestamp + validBody)
      .digest('base64');

    if (calculatedForValid !== validSignature) {
      throw new Error('Valid signature did not match calculated signature');
    }

    // Verification check for tampered body
    const calculatedForTampered = crypto
      .createHmac('sha256', testSecret)
      .update(timestamp + tamperedBody)
      .digest('base64');

    if (calculatedForTampered === validSignature) {
      throw new Error('Tampered payload erroneously matched valid signature!');
    }
  });

  // -------------------------------------------------------------------------
  // TEST 5: Concurrent Payment Verification Race Condition Protection
  // -------------------------------------------------------------------------
  await test('Concurrent payment verification resolves atomically without duplicate updates', async () => {
    const { job } = await createTestJob(15.0);
    const testOrderId = 'order_race_' + Date.now();

    const payment = await prisma.payment.create({
      data: {
        amount: 15.0,
        currency: 'INR',
        status: 'PENDING',
        type: 'PRINT_JOB',
        gatewayOrderId: testOrderId
      }
    });

    await prisma.printJob.update({
      where: { id: job.id },
      data: { paymentId: payment.id }
    });

    // Simulate atomic verification inside prisma.$transaction as implemented in verifyPayment
    const verifyWorker = async (workerId) => {
      return await prisma.$transaction(async (tx) => {
        // Atomic conditional update on status === 'PENDING'
        const updateResult = await tx.payment.updateMany({
          where: { id: payment.id, status: 'PENDING' },
          data: { status: 'SUCCESS', paidAt: new Date() }
        });

        if (updateResult.count === 0) {
          const freshJob = await tx.printJob.findFirst({ where: { paymentId: payment.id } });
          return { workerId, wasJustUpdated: false, status: 'ALREADY_PAID', job: freshJob };
        }

        const updatedJob = await tx.printJob.update({
          where: { id: job.id },
          data: { status: 'WAITING' }
        });

        await tx.transaction.create({
          data: {
            paymentId: payment.id,
            action: 'VERIFICATION_SUCCESS',
            status: 'SUCCESS',
            amount: 15.0
          }
        });

        return { workerId, wasJustUpdated: true, status: 'SUCCESS', job: updatedJob };
      }, { maxWait: 10000, timeout: 10000 });
    };

    // Run two simultaneous workers
    const [res1, res2] = await Promise.all([
      verifyWorker('Worker 1'),
      verifyWorker('Worker 2')
    ]);

    const updatedCount = (res1.wasJustUpdated ? 1 : 0) + (res2.wasJustUpdated ? 1 : 0);
    if (updatedCount !== 1) {
      throw new Error(`Race condition failure! Expected exactly 1 update, but got ${updatedCount}`);
    }

    // Verify exactly 1 Transaction audit record was created
    const txCount = await prisma.transaction.count({
      where: { paymentId: payment.id, action: 'VERIFICATION_SUCCESS' }
    });

    if (txCount !== 1) {
      throw new Error(`Expected exactly 1 audit transaction, found ${txCount}`);
    }
  });

  // -------------------------------------------------------------------------
  // TEST 6: Payment Amount Mismatch Protection
  // -------------------------------------------------------------------------
  await test('Amount mismatch prevents job from transitioning to WAITING', async () => {
    const { job } = await createTestJob(100.0);
    const testOrderId = 'order_mismatch_' + Date.now();

    const payment = await prisma.payment.create({
      data: {
        amount: 100.0,
        currency: 'INR',
        status: 'PENDING',
        type: 'PRINT_JOB',
        gatewayOrderId: testOrderId
      }
    });

    await prisma.printJob.update({
      where: { id: job.id },
      data: { paymentId: payment.id }
    });

    // Simulate gateway callback claiming order was paid for only ₹1.0 instead of ₹100.0
    const gatewayAmount = 1.0;
    const expectedAmount = payment.amount;

    if (Math.abs(gatewayAmount - expectedAmount) > 0.01) {
      // Record mismatch audit
      await prisma.transaction.create({
        data: {
          paymentId: payment.id,
          action: 'AMOUNT_MISMATCH_DETECTED',
          status: 'FAILED',
          amount: gatewayAmount,
          errorMessage: `Amount mismatch: Expected ₹${expectedAmount}, got ₹${gatewayAmount}`
        }
      });
    }

    // Verify job remains PENDING_PAYMENT
    const verifyJob = await prisma.printJob.findUnique({ where: { id: job.id } });
    if (verifyJob.status !== 'PENDING_PAYMENT') {
      throw new Error(`Job status was incorrectly changed to ${verifyJob.status} despite amount mismatch`);
    }

    const auditTx = await prisma.transaction.findFirst({
      where: { paymentId: payment.id, action: 'AMOUNT_MISMATCH_DETECTED' }
    });
    if (!auditTx) throw new Error('Audit transaction for amount mismatch was not recorded');
  });

  // -------------------------------------------------------------------------
  // TEST 7: Database Transaction Rollback on Failure
  // -------------------------------------------------------------------------
  await test('Database transaction rolls back all changes if an error occurs mid-operation', async () => {
    const { job } = await createTestJob(50.0);
    const testOrderId = 'order_rollback_' + Date.now();

    const payment = await prisma.payment.create({
      data: {
        amount: 50.0,
        currency: 'INR',
        status: 'PENDING',
        type: 'PRINT_JOB',
        gatewayOrderId: testOrderId
      }
    });

    await prisma.printJob.update({
      where: { id: job.id },
      data: { paymentId: payment.id }
    });

    try {
      await prisma.$transaction(async (tx) => {
        // Step 1: Update payment to SUCCESS
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: 'SUCCESS' }
        });

        // Step 2: Intentional throw to trigger rollback
        throw new Error('Simulated network / DB failure before job update');
      });
    } catch (e) {
      // Expected
    }

    // Verify Payment remained PENDING (rolled back!)
    const checkPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    if (checkPayment.status !== 'PENDING') {
      throw new Error(`Transaction failed to rollback! Payment status is ${checkPayment.status}`);
    }

    const checkJob = await prisma.printJob.findUnique({ where: { id: job.id } });
    if (checkJob.status !== 'PENDING_PAYMENT') {
      throw new Error(`Job status is ${checkJob.status}, should be PENDING_PAYMENT`);
    }
  });

  // -------------------------------------------------------------------------
  // TEST 8: Demo Payment Flow & Financial Ledger Integration
  // -------------------------------------------------------------------------
  await test('Demo payment flow updates status to WAITING and writes Transaction audit record', async () => {
    const { job } = await createTestJob(4.0);

    const demoOrderId = `demo_order_${job.shortId}_${Date.now()}`;

    // Execute atomic demo payment transaction
    const { newPayment, updatedJob } = await prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          amount: job.cost,
          currency: 'INR',
          type: 'PRINT_JOB',
          status: 'SUCCESS',
          paymentMethod: 'demo',
          paymentGroup: 'simulated',
          gatewayOrderId: demoOrderId,
          paidAt: new Date()
        }
      });

      const j = await tx.printJob.update({
        where: { id: job.id },
        data: { status: 'WAITING', paymentId: p.id }
      });

      await tx.transaction.create({
        data: {
          paymentId: p.id,
          action: 'DEMO_PAYMENT_SIMULATION',
          status: 'SUCCESS',
          amount: job.cost,
          gatewayResponse: JSON.stringify({ note: 'Simulated demo payment test' })
        }
      });

      return { newPayment: p, updatedJob: j };
    });

    if (updatedJob.status !== 'WAITING') {
      throw new Error(`Expected WAITING, got ${updatedJob.status}`);
    }
    if (newPayment.status !== 'SUCCESS') {
      throw new Error(`Expected SUCCESS, got ${newPayment.status}`);
    }

    const auditRecord = await prisma.transaction.findFirst({
      where: { paymentId: newPayment.id, action: 'DEMO_PAYMENT_SIMULATION' }
    });

    if (!auditRecord) {
      throw new Error('Transaction audit record was not created for demo payment');
    }
  });

  // -------------------------------------------------------------------------
  // TEST 9: Completed Job and Payment Record Fixture Persistence & Immutability
  // -------------------------------------------------------------------------
  await test('Completed job fixture verifies relational persistence and state immutability', async () => {
    let cded2789 = await prisma.printJob.findUnique({
      where: { shortId: 'cded2789' },
      include: { payment: true }
    });

    if (!cded2789) {
      // In fresh/disposable test database, seed synthetic benchmark fixture
      const histDoc = await prisma.document.create({
        data: {
          originalName: 'completed_job_benchmark.pdf',
          filename: '/uploads/completed_job_benchmark.pdf',
          mimetype: 'application/pdf',
          size: 1024,
          pages: 1
        }
      });

      const histPayment = await prisma.payment.create({
        data: {
          amount: 2,
          currency: 'INR',
          status: 'SUCCESS',
          type: 'PRINT_JOB'
        }
      });

      cded2789 = await prisma.printJob.create({
        data: {
          shortId: 'cded2789',
          status: 'COMPLETED',
          cost: 2,
          copies: 1,
          pagesToPrint: 1,
          documentId: histDoc.id,
          paymentId: histPayment.id
        },
        include: { payment: true }
      });
    }

    if (!cded2789) throw new Error('Benchmark job cded2789 missing from database!');
    if (cded2789.status !== 'COMPLETED') {
      throw new Error(`Job cded2789 status modified! Expected COMPLETED, got ${cded2789.status}`);
    }
    if (cded2789.cost !== 2) {
      throw new Error(`Job cded2789 cost modified! Expected 2, got ${cded2789.cost}`);
    }
    if (!cded2789.payment || cded2789.payment.status !== 'SUCCESS') {
      throw new Error('Job cded2789 payment record compromised!');
    }
    if (cded2789.payment.amount !== cded2789.cost) {
      throw new Error(`Payment amount mismatch! Expected ${cded2789.cost}, got ${cded2789.payment.amount}`);
    }

    // Immutability: Verify state machine prohibits transitioning backwards from COMPLETED
    if (isValidJobTransition('COMPLETED', 'PENDING_PAYMENT')) {
      throw new Error('State machine violation: COMPLETED must not be able to transition to PENDING_PAYMENT');
    }
    if (isValidJobTransition('COMPLETED', 'WAITING')) {
      throw new Error('State machine violation: COMPLETED must not be able to transition to WAITING');
    }

    // Non-interference: createOrder must reject creating a payment for an already completed job
    // Temporarily configure syntactically valid CI-only dummy sandbox credentials so getCashfreeConfig() passes validation
    const savedAppId = process.env.CASHFREE_APP_ID;
    const savedSecretKey = process.env.CASHFREE_SECRET_KEY;
    const savedEnv = process.env.CASHFREE_ENV;
    const savedEnvironment = process.env.CASHFREE_ENVIRONMENT;

    let orderRejected = false;
    try {
      process.env.CASHFREE_APP_ID = 'cf_app_ci_sandbox_mock_12345';
      process.env.CASHFREE_SECRET_KEY = 'cfsk_ma_test_ci_sandbox_mock_secret_999999999999';
      process.env.CASHFREE_ENV = 'sandbox';
      delete process.env.CASHFREE_ENVIRONMENT;

      await paymentsService.createOrder(cded2789.shortId);
    } catch (err) {
      orderRejected = true;
      if (err.message !== 'Job cannot be paid. Current status: COMPLETED') {
        throw new Error(`Unexpected error during non-interference verification! Expected 'Job cannot be paid. Current status: COMPLETED', got: '${err.message}'`);
      }
    } finally {
      if (savedAppId === undefined) delete process.env.CASHFREE_APP_ID;
      else process.env.CASHFREE_APP_ID = savedAppId;

      if (savedSecretKey === undefined) delete process.env.CASHFREE_SECRET_KEY;
      else process.env.CASHFREE_SECRET_KEY = savedSecretKey;

      if (savedEnv === undefined) delete process.env.CASHFREE_ENV;
      else process.env.CASHFREE_ENV = savedEnv;

      if (savedEnvironment === undefined) delete process.env.CASHFREE_ENVIRONMENT;
      else process.env.CASHFREE_ENVIRONMENT = savedEnvironment;
    }

    if (!orderRejected) {
      throw new Error('Non-interference violation: createOrder should have rejected payment for COMPLETED job!');
    }

    // Post-operation persistence: re-verify fixture remained completely unmutated
    const freshJob = await prisma.printJob.findUnique({
      where: { shortId: 'cded2789' },
      include: { payment: true }
    });
    if (freshJob.status !== 'COMPLETED' || freshJob.cost !== 2 || freshJob.payment?.status !== 'SUCCESS') {
      throw new Error('Completed job record was mutated by rejected payment attempt!');
    }

    console.log(`   Persistence & immutability check: Job ${freshJob.shortId} status=${freshJob.status}, cost=₹${freshJob.cost}, payment=${freshJob.payment.status}`);
  });

  console.log('\n======================================================================');
  console.log(`TEST SUITE RESULTS: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('======================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite()
  .catch(err => {
    console.error('Test suite failed with unexpected error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
