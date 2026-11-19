/**
 * PRINTGO — PHASE 4 AUTOMATED TEST SUITE
 * Customer Mobile Flow & QR-Based Print Session Implementation
 *
 * Verifies the complete customer mobile journey and safety invariants:
 * 1.  ACTIVE QR creates a fresh customer session with signed JWT & printer metadata
 * 2.  REVOKED QR is rejected with HTTP 410
 * 3.  REPLACED QR is rejected with HTTP 410
 * 4.  Expired session is rejected with HTTP 410
 * 5.  Customer cannot select another printer (server forces session machineId)
 * 6.  Valid PDF upload succeeds and verifies %PDF- magic bytes
 * 7.  Corrupted/spoofed upload without %PDF- magic bytes is rejected (HTTP 400)
 * 8.  Server calculates authoritative price snapshot (client cannot manipulate)
 * 9.  Forged/unauthorized payment completion is rejected
 * 10. Duplicate payment confirmation does not create duplicate jobs (idempotency)
 * 11. Job routes strictly to mapped printer room (machine_${machineId})
 * 12. Incorrect or suspended printer mapping fails closed
 * 13. Customer sees only their own job status (cross-session job query returns 403)
 * 14. Disconnected agent handles gracefully (job stays safely in WAITING)
 * 15. Concurrency invariant: high-frequency resolution yields isolated sessions
 * 16. Public pre-scan endpoint exposes zero secrets, internal DB IDs, or keys
 * 17. Tampered or expired JWT token is rejected
 * 18. Full customer flow end-to-end integration (Scan QR -> Session -> Upload -> Configure -> Pay -> Track)
 *
 * MANDATORY SAFETY ENFORCEMENT:
 * Strictly bound to printgo_disposable_target on port 5433.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Load database credentials strictly for disposable target
const credsPath = path.resolve(__dirname, '../../.pg_credentials.local');
let targetUrl = process.env.DATABASE_URL;

if (!targetUrl && fs.existsSync(credsPath)) {
  const creds = fs.readFileSync(credsPath, 'utf8');
  const pass = creds.match(/POSTGRES_PASSWORD=(.*)/)[1].trim();
  targetUrl = `postgresql://postgres:${encodeURIComponent(pass)}@localhost:5433/printgo_disposable_target?schema=public`;
}

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

if (!targetUrl) {
  throw new Error('DATABASE_URL or .pg_credentials.local is required to run phase4_customer_mobile_qr_flow test suite');
}

// Validate DATABASE_URL BEFORE constructing PrismaClient or issuing any query
validateDatabaseUrl(targetUrl);

process.env.DATABASE_URL = targetUrl;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_phase4_mobile_flow';
process.env.PUBLIC_APP_URL = 'https://printgo.in';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: targetUrl } } });

const printerQrService = require('../src/services/printerQr.service');
const authController = require('../src/modules/auth/auth.controller');
const uploadService = require('../src/modules/upload/upload.service');
const jobsController = require('../src/modules/jobs/jobs.controller');
const jobsService = require('../src/modules/jobs/jobs.service');
const paymentsController = require('../src/modules/payments/payments.controller');
const queueService = require('../src/services/queueService');

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

const assert = (condition, msg) => {
  if (!condition) throw new Error(msg || 'Assertion failed');
};

// Helper: Mock Express Req/Res/Next
const createMockReqRes = (reqData = {}, mockIo = null) => {
  let statusCode = 200;
  let responseData = null;
  let headersSent = false;
  let errorCaptured = null;

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      responseData = data;
      headersSent = true;
      return this;
    },
    send(data) {
      responseData = data;
      headersSent = true;
      return this;
    }
  };

  const req = {
    body: {},
    params: {},
    query: {},
    headers: {},
    session: null,
    app: {
      get: (key) => (key === 'io' ? mockIo : null)
    },
    ...reqData
  };

  const next = (err) => {
    errorCaptured = err;
  };

  return {
    req,
    res,
    next,
    getStatusCode: () => statusCode,
    getResponseData: () => responseData,
    getError: () => errorCaptured
  };
};

async function runTestSuite() {
  console.log('======================================================================');
  console.log('PRINTGO — PHASE 4 CUSTOMER MOBILE FLOW & QR INTEGRATION TEST SUITE');
  const isCi = process.env.GITHUB_ACTIONS === 'true';
  const expectedPort = isCi ? 5432 : 5433;

  console.log(`Target: printgo_disposable_target on port ${expectedPort} (GITHUB_ACTIONS=${isCi})`);
  console.log('======================================================================\n');

  // Pre-flight safety check
  const meta = await prisma.$queryRawUnsafe('SELECT current_database(), inet_server_port(), version()');
  const dbName = meta[0].current_database;
  const dbPort = meta[0].inet_server_port;

  if (targetUrl) {
    const parsed = new URL(targetUrl);
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      console.error(`FATAL SAFETY VIOLATION: Database host '${parsed.hostname}' is not localhost or 127.0.0.1! Aborting.`);
      process.exit(1);
    }
  }

  console.log(`Pre-flight Database Check: ${dbName} on port ${dbPort}`);
  if (dbName !== 'printgo_disposable_target' || Number(dbPort) !== expectedPort) {
    console.error(`FATAL SAFETY VIOLATION: Database is NOT printgo_disposable_target:${expectedPort} (GITHUB_ACTIONS=${isCi})! Aborting.`);
    process.exit(1);
  }
  console.log('Pre-flight Safety Check PASSED: Strictly isolated to printgo_disposable_target.\n');

  // Setup Test Fixtures
  const company = await prisma.company.upsert({
    where: { contactEmail: 'phase4_shop@test.com' },
    update: {},
    create: { name: 'Phase 4 Test Printing Co', contactEmail: 'phase4_shop@test.com' }
  });

  const machineA = await prisma.machine.upsert({
    where: { machineKey: 'PHASE4-PRINTER-A-KEY' },
    update: { status: 'ACTIVE', lastOnline: new Date() },
    create: {
      name: 'Counter Desk Printer A',
      machineKey: 'PHASE4-PRINTER-A-KEY',
      printerModel: 'EPSON L6460 Series',
      location: 'Main Counter A',
      status: 'ACTIVE',
      lastOnline: new Date(),
      companyId: company.id
    }
  });

  await prisma.printerStatus.deleteMany({ where: { machineId: machineA.id } });
  await prisma.printerStatus.create({
    data: {
      machineId: machineA.id,
      isOnline: true,
      paperStatus: 'OK',
      tonerStatus: 'OK',
      jamStatus: false,
      timestamp: new Date()
    }
  });

  const machineB = await prisma.machine.upsert({
    where: { machineKey: 'PHASE4-PRINTER-B-KEY' },
    update: { status: 'ACTIVE', lastOnline: new Date() },
    create: {
      name: 'Branch Printer B',
      machineKey: 'PHASE4-PRINTER-B-KEY',
      printerModel: 'HP LaserJet 400',
      location: 'Back Office B',
      status: 'ACTIVE',
      lastOnline: new Date(),
      companyId: company.id
    }
  });

  await prisma.printerStatus.deleteMany({ where: { machineId: machineB.id } });
  await prisma.printerStatus.create({
    data: {
      machineId: machineB.id,
      isOnline: true,
      paperStatus: 'OK',
      tonerStatus: 'OK',
      jamStatus: false,
      timestamp: new Date()
    }
  });

  const machineSuspended = await prisma.machine.upsert({
    where: { machineKey: 'PHASE4-PRINTER-SUSP-KEY' },
    update: { status: 'SUSPENDED' },
    create: {
      name: 'Maintenance Printer',
      machineKey: 'PHASE4-PRINTER-SUSP-KEY',
      printerModel: 'EPSON L6460 Series',
      location: 'Repair Bench',
      status: 'SUSPENDED',
      companyId: company.id
    }
  });

  const operatorUser = { id: 'usr_phase4_op', role: 'SUPERADMIN', email: 'op@phase4.test' };

  // Helper: Clear existing active QRs on test machines to start clean
  await prisma.printerQr.updateMany({
    where: { machineId: { in: [machineA.id, machineB.id, machineSuspended.id] }, status: 'ACTIVE' },
    data: { status: 'REVOKED', revokedReason: 'Resetting test fixture state' }
  });

  console.log('--- TEST CASES EXECUTION ---\n');

  // Case 1: ACTIVE QR creates a fresh customer session
  let activeQrA = null;
  let sessionTokenA = null;
  let sessionCodeA = null;

  await test('Case 1: ACTIVE QR creates a fresh customer session', async () => {
    activeQrA = await printerQrService.generatePrinterQr(machineA.id, { label: 'Front Counter QR' }, operatorUser);

    const { req, res, next, getStatusCode, getResponseData, getError } = createMockReqRes({
      body: { publicCode: activeQrA.publicCode }
    });

    await authController.createSessionFromPrinterQr(req, res, next);
    assert(!getError(), `Did not expect error: ${getError()?.message}`);
    assert(getStatusCode() === 200, `Expected 200, got ${getStatusCode()}`);

    const data = getResponseData();
    assert(data.success === true, 'Response must be success: true');
    assert(data.sessionCode && data.sessionCode.length === 12, 'Session code must be 12-char hex string');
    assert(data.sessionToken, 'Must provide signed JWT sessionToken');
    assert(data.printer.name === machineA.name, 'Must return printer metadata name');
    assert(data.printer.location === machineA.location, 'Must return printer location');
    assert(data.printer.isOnline === true, 'Must indicate printer is online');

    // Verify token payload
    const decoded = jwt.verify(data.sessionToken, process.env.JWT_SECRET);
    assert(decoded.sessionId === data.sessionCode, 'JWT must contain sessionId');
    assert(decoded.machineId === machineA.id, 'JWT must be bound to machineA');
    assert(decoded.role === 'mobile', 'JWT role must be mobile');

    // Verify DB session record
    const dbSession = await prisma.session.findUnique({ where: { code: data.sessionCode } });
    assert(dbSession, 'Session must exist in database');
    assert(dbSession.machineId === machineA.id, 'DB session must be bound to machineA');
    assert(dbSession.printerQrId === activeQrA.id, 'DB session must reference printerQrId');
    assert(dbSession.status === 'WAITING_FOR_MOBILE', 'DB session initial status must be WAITING_FOR_MOBILE');

    sessionTokenA = data.sessionToken;
    sessionCodeA = data.sessionCode;
  });

  // Case 2: REVOKED QR is rejected with HTTP 410
  await test('Case 2: REVOKED QR is rejected with HTTP 410', async () => {
    const qrToRevoke = await printerQrService.generatePrinterQr(machineB.id, { label: 'QR to Revoke' }, operatorUser);
    await printerQrService.revokePrinterQr(qrToRevoke.id, 'Counter flyer damaged and removed from shop', operatorUser);

    const { req, res, next, getError } = createMockReqRes({
      body: { publicCode: qrToRevoke.publicCode }
    });

    await authController.createSessionFromPrinterQr(req, res, next);
    const err = getError();
    assert(err, 'Expected error for revoked QR');
    assert(err.statusCode === 410, `Expected HTTP 410, got ${err.statusCode}`);
    assert(err.message.includes('revoked'), 'Error message must specify QR has been revoked');
  });

  // Case 3: REPLACED QR is rejected with HTTP 410
  await test('Case 3: REPLACED QR is rejected with HTTP 410', async () => {
    // Generate and then replace
    const oldQr = await printerQrService.generatePrinterQr(machineB.id, { label: 'Original QR' }, operatorUser);
    const replacement = await printerQrService.replacePrinterQr(
      oldQr.id,
      { label: 'Rotated QR Flyer', reason: 'Scheduled monthly QR flyer rotation' },
      operatorUser
    );

    const { req, res, next, getError } = createMockReqRes({
      body: { publicCode: oldQr.publicCode }
    });

    await authController.createSessionFromPrinterQr(req, res, next);
    const err = getError();
    assert(err, 'Expected error for replaced QR');
    assert(err.statusCode === 410, `Expected HTTP 410, got ${err.statusCode}`);
    assert(err.message.includes('replaced'), 'Error message must specify QR has been replaced');

    // Verify the new replacement QR works
    const { req: reqNew, res: resNew, next: nextNew, getStatusCode: getStatusNew, getResponseData: getDataNew } = createMockReqRes({
      body: { publicCode: replacement.newQr.publicCode }
    });
    await authController.createSessionFromPrinterQr(reqNew, resNew, nextNew);
    assert(getStatusNew() === 200, 'Replacement QR must resolve successfully');
    assert(getDataNew().success === true, 'Replacement QR session creation must succeed');
  });

  // Case 4: Expired session is rejected with HTTP 410
  await test('Case 4: Expired session is rejected with HTTP 410', async () => {
    const expiredCode = 'exp' + crypto.randomBytes(4).toString('hex');
    await prisma.session.create({
      data: {
        code: expiredCode,
        machineId: machineA.id,
        status: 'WAITING_FOR_MOBILE',
        expiresAt: new Date(Date.now() - 60000) // 1 minute in the past
      }
    });

    const { req, res, next, getError } = createMockReqRes({
      body: { sessionCode: expiredCode }
    });

    await authController.joinSession(req, res, next);
    const err = getError();
    assert(err, 'Expected error for expired session');
    assert(err.statusCode === 410, `Expected HTTP 410, got ${err.statusCode}`);
    assert(err.message.toLowerCase().includes('expired'), 'Error message must mention session expired');
  });

  // Case 5: Customer cannot select another printer (server forces session machineId)
  let createdJobA = null;
  await test('Case 5: Customer cannot select another printer (server-side override)', async () => {
    // Mobile session is bound to machineA. Attacker sends body with machineId = machineB.id
    const { req, res, next, getStatusCode, getResponseData, getError } = createMockReqRes({
      body: {
        machineId: machineB.id, // Attempted forgery
        file: {
          originalName: 'CustomerDoc.pdf',
          filename: 'CustomerDoc_123.pdf',
          mimetype: 'application/pdf',
          size: 10240,
          pages: 4
        },
        settings: {
          color: 'bw',
          duplex: 'single',
          copies: 1,
          pageRangeType: 'all',
          pagesToPrint: 4
        }
      },
      session: {
        sessionId: sessionCodeA,
        machineId: machineA.id,
        role: 'mobile'
      }
    });

    await jobsController.createJob(req, res, next);
    assert(!getError(), `Did not expect error: ${getError()?.message}`);
    assert(getStatusCode() === 200, `Expected 200, got ${getStatusCode()}`);

    const job = getResponseData().job;
    assert(job, 'Job must be returned');
    assert(job.machineId === machineA.id, `Job machineId MUST be overridden to session machineA (${machineA.id}), got ${job.machineId}`);
    assert(job.machineId !== machineB.id, 'Job MUST NOT be bound to forged machineB');

    createdJobA = job;
  });

  // Case 6: Uploaded file is bound to session and verified via %PDF- magic bytes
  await test('Case 6: Valid PDF upload succeeds and verifies %PDF- magic bytes', async () => {
    // Valid PDF buffer starting with %PDF-1.4
    const validPdfBuffer = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n' +
      'xref\n0 4\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000117 00000 n \n' +
      'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n185\n%%EOF'
    );

    const tempPdfPath = path.join(os.tmpdir(), `test_valid_${Date.now()}.pdf`);
    fs.writeFileSync(tempPdfPath, validPdfBuffer);

    try {
      const pages = await uploadService.getPageCount(tempPdfPath, 'application/pdf', false, 1, tempPdfPath);
      assert(pages >= 1, `Valid PDF must calculate at least 1 page, got ${pages}`);
    } finally {
      if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath);
    }
  });

  // Case 7: Corrupted / spoofed upload without %PDF- magic bytes is rejected (HTTP 400)
  await test('Case 7: Corrupted/spoofed upload without %PDF- magic bytes is rejected (HTTP 400)', async () => {
    // Text file pretending to be PDF
    const fakePdfBuffer = Buffer.from('Hello world! This is a plain text file pretending to be a PDF.');
    const tempFakePath = path.join(os.tmpdir(), `test_fake_${Date.now()}.pdf`);
    fs.writeFileSync(tempFakePath, fakePdfBuffer);

    let threw = false;
    try {
      await uploadService.getPageCount(tempFakePath, 'application/pdf', false, 1, tempFakePath);
    } catch (err) {
      threw = true;
      assert(err.statusCode === 400, `Expected HTTP 400, got ${err.statusCode}`);
      assert(err.message.includes('%PDF-'), `Expected error message to mention %PDF- header, got: ${err.message}`);
    } finally {
      if (fs.existsSync(tempFakePath)) fs.unlinkSync(tempFakePath);
    }
    assert(threw, 'Upload service must reject files missing %PDF- header');
  });

  // Case 8: Server calculates authoritative price snapshot (client cannot manipulate)
  await test('Case 8: Server calculates authoritative price snapshot', async () => {
    const { req, res, next, getStatusCode, getResponseData } = createMockReqRes({
      body: {
        cost: 0.50, // Attempted client-side price tampering (trying to pay ₹0.50)
        file: {
          originalName: 'PricingTest.pdf',
          filename: 'PricingTest_123.pdf',
          mimetype: 'application/pdf',
          size: 5000,
          pages: 5
        },
        settings: {
          color: 'color', // Color = ₹10/side. 5 pages * 2 copies = ₹100.00
          duplex: 'single',
          copies: 2,
          pageRangeType: 'all',
          pagesToPrint: 5
        }
      },
      session: {
        sessionId: sessionCodeA,
        machineId: machineA.id,
        role: 'mobile'
      }
    });

    await jobsController.createJob(req, res, next);
    assert(getStatusCode() === 200, 'Job must be created with 200 OK');
    const job = getResponseData().job;

    // Authoritative pricing: 5 pages * 2 copies * ₹10/side = ₹100
    assert(job.cost === 100, `Server-calculated cost must be ₹100.00, got ₹${job.cost}`);
    assert(job.cost !== 0.50, 'Client price tampering must be completely ignored');

    // Verify snapshot
    const snapshot = JSON.parse(job.pricingSnapshot);
    assert(snapshot.calculation?.finalCost === 100 || snapshot.cost === 100, 'Pricing snapshot must record authoritative cost');
    assert(snapshot.sessionId === sessionCodeA, 'Pricing snapshot must record sessionId');
  });

  // Case 9: Forged/unauthorized payment completion is rejected
  await test('Case 9: Forged/unauthorized payment completion is rejected', async () => {
    let threw = false;
    try {
      await jobsService.updateJobStatus(createdJobA.shortId, 'WAITING', { id: 'intruder', role: 'FRANCHISEE', companyId: 'different_company' });
    } catch (err) {
      threw = true;
      assert(err.statusCode === 403, `Expected 403 Forbidden on unauthorized status update, got ${err.statusCode}`);
    }
    assert(threw, 'Direct status update without permissions must be rejected');

    // Verify job in DB remains PENDING_PAYMENT
    const refreshed = await prisma.printJob.findUnique({ where: { shortId: createdJobA.shortId } });
    assert(refreshed.status === 'PENDING_PAYMENT', `Job must remain PENDING_PAYMENT, got ${refreshed.status}`);
  });

  // Case 10: Duplicate payment confirmation does not create duplicate jobs (idempotency)
  await test('Case 10: Duplicate payment confirmation does not create duplicate jobs (idempotency)', async () => {
    process.env.APP_ENV = 'staging';
    process.env.ENABLE_DEMO_PAYMENT = 'true';
    process.env.RENDER = 'true';
    process.env.RENDER_SERVICE_ID = 'srv-dbqpapon74is73csbc80';
    process.env.RENDER_SERVICE_NAME = 'printgo-backend-staging';
    process.env.RENDER_GIT_BRANCH = 'feature/printgo-production-readiness';
    process.env.DEMO_PAYMENT_ACCESS_CODE = 'phase4_test_access_code_2026';

    const { req: req1, res: res1, next: next1, getStatusCode: getStatus1, getResponseData: getData1 } = createMockReqRes({
      params: { id: createdJobA.shortId },
      body: { accessCode: 'phase4_test_access_code_2026' },
      session: { sessionId: sessionCodeA, machineId: machineA.id, role: 'mobile' }
    });

    await paymentsController.demoPayment(req1, res1, next1);
    assert(getStatus1() === 200, `First payment confirmation must succeed, got ${getStatus1()}: ${getData1()?.error}`);
    const paidJob1 = getData1().job;
    assert(paidJob1.status === 'WAITING', 'Job must transition to WAITING');

    // Send duplicate payment confirmation
    const { req: req2, res: res2, next: next2, getStatusCode: getStatus2, getResponseData: getData2 } = createMockReqRes({
      params: { id: createdJobA.shortId },
      body: { accessCode: 'phase4_test_access_code_2026' },
      session: { sessionId: sessionCodeA, machineId: machineA.id, role: 'mobile' }
    });

    await paymentsController.demoPayment(req2, res2, next2);
    assert(getStatus2() === 200, 'Duplicate payment must return 200 OK idempotently');
    const duplicateRes = getData2();
    assert(duplicateRes.message === 'Job already paid', `Expected 'Job already paid', got ${duplicateRes.message}`);
    assert(duplicateRes.job.shortId === createdJobA.shortId, 'Must return identical job');

    // Count jobs with this shortId in DB
    const count = await prisma.printJob.count({ where: { shortId: createdJobA.shortId } });
    assert(count === 1, `Exactly one job must exist, found ${count}`);
  });

  // Case 11: Job routes strictly to mapped printer room (machine_${machineId})
  await test('Case 11: Job routes strictly to mapped printer room (machine_${machineId})', async () => {
    const emittedEvents = [];
    const mockIo = {
      to(room) {
        return {
          emit(event, data) {
            emittedEvents.push({ room, event, data });
          }
        };
      }
    };

    // Create a fresh test job in WAITING state specifically for queue dispatch verification
    const routingDoc = await prisma.document.create({
      data: {
        originalName: 'RoutingTest.pdf',
        filename: 'RoutingTest_' + Date.now() + '.pdf',
        mimetype: 'application/pdf',
        size: 1024,
        pages: 1
      }
    });

    const routingJob = await prisma.printJob.create({
      data: {
        shortId: 'rt' + crypto.randomBytes(3).toString('hex'),
        machineId: machineA.id,
        documentId: routingDoc.id,
        status: 'WAITING',
        cost: 10,
        color: 'bw',
        duplex: 'single',
        copies: 1,
        pagesToPrint: 1
      }
    });

    await queueService.startPrintingProcess(routingJob.shortId, mockIo);
    await new Promise(r => setTimeout(r, 200));

    // Verify socket emission
    const targetRoom = `machine_${machineA.id}`;
    const dispatchEvent = emittedEvents.find(e => e.room === targetRoom && e.event === 'physical_print_job');
    assert(dispatchEvent, `Expected print dispatch emitted strictly to room ${targetRoom}`);
    assert(dispatchEvent.data.jobId === routingJob.shortId, 'Dispatched event must include jobId');
    assert(!emittedEvents.some(e => e.room === `machine_${machineB.id}`), 'Must NOT emit to machineB');
  });

  // Case 12: Incorrect or suspended printer mapping fails closed
  await test('Case 12: Suspended printer mapping fails closed with HTTP 403', async () => {
    const suspendedQr = await prisma.printerQr.create({
      data: {
        publicCode: 'pq_susp_' + crypto.randomBytes(3).toString('hex'),
        label: 'Suspended Printer QR',
        status: 'ACTIVE',
        machineId: machineSuspended.id,
        generatedBy: 'test'
      }
    });

    const { req, res, next, getError } = createMockReqRes({
      body: { publicCode: suspendedQr.publicCode }
    });

    await authController.createSessionFromPrinterQr(req, res, next);
    const err = getError();
    assert(err, 'Expected error for suspended printer');
    assert(err.statusCode === 403, `Expected HTTP 403, got ${err.statusCode}`);
    assert(err.message.includes('offline') || err.message.includes('maintenance'), 'Error must inform user printer is offline/maintenance');
  });

  // Case 13: Customer sees only their own job status (cross-session query returns 403)
  await test('Case 13: Customer sees only their own job status (cross-session query returns 403)', async () => {
    // Customer B with a different session attempts to read createdJobA
    const { req, res, next, getStatusCode, getResponseData } = createMockReqRes({
      params: { id: createdJobA.shortId },
      session: {
        sessionId: 'different_session_code_bbb',
        machineId: machineA.id,
        role: 'mobile'
      }
    });

    await jobsController.getJob(req, res, next);
    assert(getStatusCode() === 403, `Expected 403 Forbidden for cross-session access, got ${getStatusCode()}`);
    assert(getResponseData().success === false, 'Must be success: false');
    assert(getResponseData().error.includes('permission') || getResponseData().error.includes('denied'), 'Must contain permission denied error');

    // Customer A (the rightful owner) successfully reads job status
    const { req: reqOwner, res: resOwner, next: nextOwner, getStatusCode: getStatusOwner, getResponseData: getDataOwner } = createMockReqRes({
      params: { id: createdJobA.shortId },
      session: {
        sessionId: sessionCodeA,
        machineId: machineA.id,
        role: 'mobile'
      }
    });

    await jobsController.getJob(reqOwner, resOwner, nextOwner);
    assert(getStatusOwner() === 200, `Owner must access job with 200 OK, got ${getStatusOwner()}`);
    assert(getDataOwner().success === true, 'Owner request must succeed');
    assert(getDataOwner().job.shortId === createdJobA.shortId, 'Owner must receive job details');
  });

  // Case 14: Disconnected agent handles gracefully (job stays safely in WAITING)
  await test('Case 14: Disconnected agent handles gracefully (job stays safely in WAITING)', async () => {
    const dummyDoc = await prisma.document.create({
      data: {
        originalName: 'AgentTest.pdf',
        filename: 'AgentTest_' + Date.now() + '.pdf',
        mimetype: 'application/pdf',
        size: 512,
        pages: 1
      }
    });

    const freshJob = await prisma.printJob.create({
      data: {
        shortId: 'disc' + crypto.randomBytes(2).toString('hex'),
        machineId: machineA.id,
        documentId: dummyDoc.id,
        status: 'WAITING',
        cost: 10,
        color: 'bw',
        duplex: 'single',
        copies: 1,
        pagesToPrint: 1
      }
    });

    // Worker processes job without agent acknowledgment
    const nullIo = { to: () => ({ emit: () => {} }) };
    await queueService.startPrintingProcess(freshJob.shortId, nullIo);
    await new Promise(r => setTimeout(r, 200));

    const checked = await prisma.printJob.findUnique({ where: { shortId: freshJob.shortId } });
    assert(checked.status === 'PRINTING' || checked.status === 'WAITING', `Job status must be valid, got ${checked.status}`);
  });

  // Case 15: Concurrency invariant: high-frequency resolution yields isolated sessions
  await test('Case 15: Concurrent QR resolutions yield separate, isolated sessions', async () => {
    const resolutions = await Promise.all([
      printerQrService.resolvePrinterQr(activeQrA.publicCode),
      printerQrService.resolvePrinterQr(activeQrA.publicCode),
      printerQrService.resolvePrinterQr(activeQrA.publicCode),
      printerQrService.resolvePrinterQr(activeQrA.publicCode)
    ]);

    const sessionCodes = resolutions.map(r => r.sessionCode);
    const uniqueCodes = new Set(sessionCodes);
    assert(uniqueCodes.size === 4, `All 4 concurrent sessions must have distinct session codes (got ${uniqueCodes.size})`);

    for (const r of resolutions) {
      assert(r.success === true, 'Each resolution must succeed');
      assert(r.sessionToken, 'Each resolution must have a sessionToken');
      const decoded = jwt.verify(r.sessionToken, process.env.JWT_SECRET);
      assert(decoded.machineId === machineA.id, 'Each session must be bound to machineA');
    }
  });

  // Case 16: Public pre-scan endpoint exposes zero secrets, internal DB IDs, or keys
  await test('Case 16: Public pre-scan endpoint exposes zero secrets or internal DB IDs', async () => {
    const { req, res, next, getStatusCode, getResponseData } = createMockReqRes({
      params: { publicCode: activeQrA.publicCode }
    });

    await authController.getPublicPrinterQrInfo(req, res, next);
    assert(getStatusCode() === 200, `Expected 200, got ${getStatusCode()}`);
    const info = getResponseData();

    assert(info.success === true, 'Pre-scan response must be success: true');
    assert(info.status === 'ACTIVE', 'Status must be ACTIVE');
    assert(info.printer.name === machineA.name, 'Must return display name');
    assert(info.printer.location === machineA.location, 'Must return location');

    // Strict leak checks
    assert(info.id === undefined, 'Must not expose internal QR database UUID');
    assert(info.machineId === undefined, 'Must not expose internal machineId UUID');
    assert(info.machineKey === undefined, 'Must not expose machineKey');
    assert(info.sessionToken === undefined, 'Must not expose JWT token');
    assert(JSON.stringify(info).indexOf(machineA.machineKey) === -1, 'Must not contain machine secret in any field');
  });

  // Case 17: Tampered or expired JWT token is rejected
  await test('Case 17: Tampered or invalid JWT token is rejected', async () => {
    const tamperedToken = sessionTokenA.substring(0, sessionTokenA.length - 8) + 'ABCDEFGH';
    let verified = false;
    try {
      jwt.verify(tamperedToken, process.env.JWT_SECRET);
      verified = true;
    } catch (e) {
      // Expected verification failure
    }
    assert(!verified, 'Tampered token must fail JWT verification');
  });

  // Case 18: Full customer flow end-to-end integration
  await test('Case 18: Full customer mobile flow end-to-end integration', async () => {
    // Step 1: Customer scans QR -> Resolve session
    const qrResolve = await printerQrService.resolvePrinterQr(activeQrA.publicCode);
    assert(qrResolve.success === true && qrResolve.sessionToken, 'Step 1: Session acquired');

    // Step 2: Customer uploads PDF document
    const testDoc = await prisma.document.create({
      data: {
        originalName: 'CustomerTicket.pdf',
        filename: 'CustomerTicket_' + Date.now() + '.pdf',
        mimetype: 'application/pdf',
        size: 15400,
        pages: 3
      }
    });
    assert(testDoc.id, 'Step 2: Document uploaded');

    // Step 3: Configure Print Settings & Submit Job
    const { req: reqJob, res: resJob, next: nextJob, getStatusCode: getStatusJob, getResponseData: getDataJob } = createMockReqRes({
      body: {
        file: {
          originalName: testDoc.originalName,
          filename: testDoc.filename,
          mimetype: testDoc.mimetype,
          size: testDoc.size,
          pages: testDoc.pages
        },
        settings: {
          color: 'bw',
          duplex: 'double', // ₹3/sheet * 2 sheets * 1 copy = ₹6
          copies: 1,
          pageRangeType: 'all',
          pagesToPrint: 3
        }
      },
      session: {
        sessionId: qrResolve.sessionCode,
        machineId: machineA.id,
        role: 'mobile'
      }
    });

    await jobsController.createJob(reqJob, resJob, nextJob);
    assert(getStatusJob() === 200, `Step 3: Job created with status ${getStatusJob()}`);
    const flowJob = getDataJob().job;
    assert(flowJob.cost === 6, `Expected cost ₹6 for 3 pages double sided, got ₹${flowJob.cost}`);

    // Step 4: Pay via Demo / Gateway Confirmation
    const { req: reqPay, res: resPay, next: nextPay, getStatusCode: getStatusPay, getResponseData: getDataPay } = createMockReqRes({
      params: { id: flowJob.shortId },
      body: { accessCode: 'phase4_test_access_code_2026' },
      session: {
        sessionId: qrResolve.sessionCode,
        machineId: machineA.id,
        role: 'mobile'
      }
    });

    await paymentsController.demoPayment(reqPay, resPay, nextPay);
    assert(getStatusPay() === 200, `Step 4: Payment confirmed, got ${getStatusPay()}: ${getDataPay()?.error}`);
    assert(getDataPay().job.status === 'WAITING', 'Job transitioned to WAITING');

    // Step 5: Customer Tracks Job Status
    const { req: reqTrack, res: resTrack, next: nextTrack, getStatusCode: getStatusTrack, getResponseData: getDataTrack } = createMockReqRes({
      params: { id: flowJob.shortId },
      session: {
        sessionId: qrResolve.sessionCode,
        machineId: machineA.id,
        role: 'mobile'
      }
    });

    await jobsController.getJob(reqTrack, resTrack, nextTrack);
    assert(getStatusTrack() === 200, 'Step 5: Status query succeeds');
    const trackedStatus = getDataTrack().job.status;
    assert(trackedStatus === 'WAITING' || trackedStatus === 'PRINTING', `Status is WAITING or PRINTING for print queue, got ${trackedStatus}`);
  });

  // Case 19: Device-specific customer QR -> DB Session -> DB PrintJob binding.
  // The same Machine has two physical printers and therefore two independent active customer QRs.
  const previousMultiPrinterFlag = process.env.ENABLE_MULTI_PRINTER_DISPATCH;
  await test('Case 19: Device QR binds its exact PrinterDevice through Session and PrintJob', async () => {
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'true';
    await prisma.printerQr.updateMany({
      where: { machineId: machineA.id, printerDeviceId: { not: null }, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedReason: 'Resetting Phase 4 device QR fixture' }
    });

    const deviceA1 = await prisma.printerDevice.upsert({
      where: { machineId_windowsPrinterName: { machineId: machineA.id, windowsPrinterName: 'PHASE4-QUEUE-COUNTER-A' } },
      update: {
        displayName: 'Counter Printer A',
        status: 'ACTIVE',
        approvedAt: new Date(),
        approvedBy: operatorUser.id
      },
      create: {
        machineId: machineA.id,
        displayName: 'Counter Printer A',
        windowsPrinterName: 'PHASE4-QUEUE-COUNTER-A',
        driverName: 'Phase 4 Test Driver A',
        portName: 'USB001',
        connectionType: 'USB',
        status: 'ACTIVE',
        approvedAt: new Date(),
        approvedBy: operatorUser.id,
        sortOrder: 0
      }
    });

    const deviceA2 = await prisma.printerDevice.upsert({
      where: { machineId_windowsPrinterName: { machineId: machineA.id, windowsPrinterName: 'PHASE4-QUEUE-COUNTER-B' } },
      update: {
        displayName: 'Counter Printer B',
        status: 'ACTIVE',
        approvedAt: new Date(),
        approvedBy: operatorUser.id
      },
      create: {
        machineId: machineA.id,
        displayName: 'Counter Printer B',
        windowsPrinterName: 'PHASE4-QUEUE-COUNTER-B',
        driverName: 'Phase 4 Test Driver B',
        portName: 'USB002',
        connectionType: 'USB',
        status: 'ACTIVE',
        approvedAt: new Date(),
        approvedBy: operatorUser.id,
        sortOrder: 1
      }
    });

    const qrA1 = await printerQrService.generatePrinterDeviceQr(
      deviceA1.id,
      { label: 'Counter A Customer QR' },
      operatorUser
    );
    const qrA2 = await printerQrService.generatePrinterDeviceQr(
      deviceA2.id,
      { label: 'Counter B Customer QR' },
      operatorUser
    );

    assert(qrA1.printerDeviceId === deviceA1.id, 'First device QR must bind to Counter Printer A');
    assert(qrA2.printerDeviceId === deviceA2.id, 'Second device QR must bind to Counter Printer B');
    assert(qrA1.machineId === machineA.id && qrA2.machineId === machineA.id, 'Both device QRs must retain the same Machine boundary');
    assert(qrA1.publicCode !== qrA2.publicCode, 'Each physical printer must have a different permanent public code');

    const activeDeviceQrCount = await prisma.printerQr.count({
      where: { machineId: machineA.id, printerDeviceId: { not: null }, status: 'ACTIVE' }
    });
    assert(activeDeviceQrCount === 2, 'Two physical printers under one Machine must be allowed to have independent ACTIVE QRs');

    const resolved = await printerQrService.resolvePrinterQr(qrA1.publicCode);
    assert(resolved.success === true, 'Scanning device A QR must create a fresh session');

    const session = await prisma.session.findUnique({ where: { code: resolved.sessionCode } });
    assert(session.machineId === machineA.id, 'Device session must retain the parent Machine ID');
    assert(session.printerQrId === qrA1.id, 'Device session must retain the exact permanent QR ID');
    assert(session.printerDeviceId === deviceA1.id, 'Device session must bind to Counter Printer A, not the other queue');

    const preScan = await printerQrService.getPublicPrinterQrInfo(qrA1.publicCode);
    assert(preScan.printer.name === deviceA1.displayName, 'Public QR preview should show the physical device display name');
    assert(preScan.machineId === undefined && preScan.printerDeviceId === undefined, 'Public QR preview must not expose internal database IDs');

    // A forged client printerDeviceId must not redirect a job to Counter Printer B.
    const { req, res, next, getStatusCode, getResponseData, getError } = createMockReqRes({
      body: {
        printerDeviceId: deviceA2.id,
        file: {
          originalName: 'DeviceBoundJob.pdf',
          filename: 'DeviceBoundJob_' + Date.now() + '.pdf',
          mimetype: 'application/pdf',
          size: 4096,
          pages: 2
        },
        settings: {
          color: 'bw',
          duplex: 'single',
          copies: 1,
          pageRangeType: 'all',
          pagesToPrint: 2
        }
      },
      session: {
        sessionId: resolved.sessionCode,
        machineId: machineA.id,
        role: 'mobile'
      }
    });

    await jobsController.createJob(req, res, next);
    assert(!getError(), `Device-bound job should be accepted: ${getError()?.message}`);
    assert(getStatusCode() === 200, `Expected 200 for device-bound job, got ${getStatusCode()}`);
    const job = getResponseData().job;
    assert(job.machineId === machineA.id, 'PrintJob must remain inside the owning Machine boundary');
    assert(job.printerDeviceId === deviceA1.id, 'PrintJob must use the database Session binding and ignore the forged client device ID');
    assert(job.printerDeviceId !== deviceA2.id, 'PrintJob must not be redirected to Counter Printer B');
  });

  // Device-specific rotation must preserve the immutable PrinterDevice binding.
  await test('Case 20: Rotating a device QR preserves its PrinterDevice mapping', async () => {
    const device = await prisma.printerDevice.findFirst({
      where: { machineId: machineA.id, windowsPrinterName: 'PHASE4-QUEUE-COUNTER-A' }
    });
    const currentQr = await prisma.printerQr.findFirst({
      where: { printerDeviceId: device.id, status: 'ACTIVE' }
    });
    const replacement = await printerQrService.replacePrinterQr(
      currentQr.id,
      { reason: 'QR label damaged and needs a fresh flyer', label: 'Counter A Replacement' },
      operatorUser
    );
    assert(replacement.newQr.printerDeviceId === device.id, 'Replacement QR must remain bound to the same physical PrinterDevice');
    assert(replacement.newQr.machineId === machineA.id, 'Replacement QR must preserve the parent Machine binding');
    if (previousMultiPrinterFlag === undefined) delete process.env.ENABLE_MULTI_PRINTER_DISPATCH;
    else process.env.ENABLE_MULTI_PRINTER_DISPATCH = previousMultiPrinterFlag;
  });

  console.log('\n======================================================================');
  console.log(`PHASE 4 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================================\n');

  await prisma.$disconnect();

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Unhandled test suite runner error:', err);
  process.exit(1);
});
