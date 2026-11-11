/**
 * PRINTGO — GATE 2A STAGING ENVIRONMENT & READ-ONLY ENFORCEMENT TEST SUITE
 * 
 * Verifies:
 * 1. Isolated staging configuration and synthetic database purity.
 * 2. Server-side ADMIN_READ_ONLY enforcement across all 14 administrative mutation endpoints.
 * 3. Read-only monitoring permissions (GET endpoints succeed).
 * 4. Customer and Printer Agent workflow preservation.
 * 5. Staging Printer Agent WebSocket authentication, heartbeat, telemetry, and reconnection.
 * 6. Admin login, JWT generation, and RBAC authorization.
 * 7. Frontend admin-only mode isolation & customer branding invariance.
 */

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const { io: ClientIo } = require(path.resolve(__dirname, '../../printer-agent/node_modules/socket.io-client'));

// Configure staging environment variables BEFORE importing app
process.env.NODE_ENV = 'staging';
process.env.ADMIN_READ_ONLY = 'true';
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required to run tests. Please configure it in backend/.env or your environment.');
}
const _dbUrl = new URL(process.env.DATABASE_URL);
process.env.DATABASE_URL = `postgresql://${_dbUrl.username}:${_dbUrl.password}@${_dbUrl.hostname}:${_dbUrl.port || 5433}/printgo_staging_db?schema=public`;
process.env.FRONTEND_URL = 'https://printgo-admin-staging.onrender.com';
process.env.CASHFREE_ENVIRONMENT = 'TEST';

const { app, server, io } = require('../src/server');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } }
});

let testAdminToken = '';
let testPort = 5098;
let testHttpServer = null;
let testSocketUrl = '';

let passedCount = 0;
let failedCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ PASS: ${message}`);
    passedCount++;
  } else {
    console.error(`❌ FAIL: ${message}`);
    failedCount++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('======================================================================');
  console.log('PRINTGO — GATE 2A STAGING & READ-ONLY ENFORCEMENT TEST SUITE');
  console.log(`Target Staging DB: ${process.env.DATABASE_URL.replace(/:[^:]*@/, ':***@')}`);
  console.log(`ADMIN_READ_ONLY:   ${process.env.ADMIN_READ_ONLY}`);
  console.log('======================================================================\n');

  // Start dedicated HTTP server for socket tests
  await new Promise((resolve) => {
    testHttpServer = server.listen(testPort, () => {
      testSocketUrl = `http://localhost:${testPort}`;
      resolve();
    });
  });

  try {
    // ------------------------------------------------------------------
    // TEST 1: Staging Database Isolation & Purity
    // ------------------------------------------------------------------
    console.log('--- 1. Testing Staging Database Isolation & Synthetic Purity ---');
    const jobCount = await prisma.printJob.count();
    const paymentCount = await prisma.payment.count();
    const company = await prisma.company.findFirst({ where: { name: 'PrintGo Staging Demo Corp' } });
    const machine = await prisma.machine.findFirst({ where: { machineKey: 'staging_machine_key_9f8e7d6c5b4a3210' } });

    assert(jobCount === 0, `Staging database has 0 production print jobs (actual: ${jobCount})`);
    assert(paymentCount === 0, `Staging database has 0 production payments (actual: ${paymentCount})`);
    assert(Boolean(company), `Synthetic staging company exists: ${company?.name}`);
    assert(Boolean(machine), `Synthetic staging machine exists: ${machine?.name} (${machine?.id})`);

    // ------------------------------------------------------------------
    // TEST 2: Health Check & System Status
    // ------------------------------------------------------------------
    console.log('\n--- 2. Testing Backend Health Check ---');
    const healthRes = await request(app).get('/api/health');
    assert(healthRes.status === 200, `GET /api/health returned 200 OK (status: ${healthRes.body.status})`);
    assert(healthRes.body.status === 'ok', 'Health status is ok');

    // ------------------------------------------------------------------
    // TEST 3: Admin Authentication & JWT Authorization
    // ------------------------------------------------------------------
    console.log('\n--- 3. Testing Admin Login & JWT Authorization ---');
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'staging_admin@printgo.in',
        password: 'StagingAdminSecret2026!'
      });

    assert(loginRes.status === 200, `POST /api/auth/login succeeded (status: ${loginRes.status})`);
    assert(Boolean(loginRes.body.token), 'Received JWT auth token');
    assert(loginRes.body.user?.role === 'SUPERADMIN', `User role is SUPERADMIN (${loginRes.body.user?.role})`);
    testAdminToken = loginRes.body.token;

    // Unauthorized request check
    const unauthRes = await request(app).get('/api/admin/stats');
    assert(unauthRes.status === 401, `Unauthenticated GET /api/admin/stats rejected with 401 (actual: ${unauthRes.status})`);

    // ------------------------------------------------------------------
    // TEST 4: Read-Only Oversight Access (Positive Tests)
    // ------------------------------------------------------------------
    console.log('\n--- 4. Testing Read-Only Oversight Access (GET Allowed) ---');
    const statsRes = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${testAdminToken}`);
    assert(statsRes.status === 200, `GET /api/admin/stats permitted (status: ${statsRes.status})`);

    const overviewRes = await request(app)
      .get('/api/admin/analytics/overview')
      .set('Authorization', `Bearer ${testAdminToken}`);
    assert(overviewRes.status === 200, `GET /api/admin/analytics/overview permitted (status: ${overviewRes.status})`);

    const machinesGetRes = await request(app)
      .get('/api/machines')
      .set('Authorization', `Bearer ${testAdminToken}`);
    assert(machinesGetRes.status === 200, `GET /api/machines permitted (status: ${machinesGetRes.status})`);

    const companiesGetRes = await request(app)
      .get('/api/companies')
      .set('Authorization', `Bearer ${testAdminToken}`);
    assert(companiesGetRes.status === 200, `GET /api/companies permitted (status: ${companiesGetRes.status})`);

    // ------------------------------------------------------------------
    // TEST 5: Server-Side ADMIN_READ_ONLY Enforcement (All 14 Mutation Endpoints)
    // ------------------------------------------------------------------
    console.log('\n--- 5. Testing Server-Side ADMIN_READ_ONLY Enforcement (All 14 Mutation Endpoints) ---');

    const expectedErrorMsg = 'Forbidden: Cloud Admin Dashboard is operating in Read-Only Monitoring Mode. Remote mutations are disabled.';

    // 1. /api/admin/dispatch-job
    const r1 = await request(app).post('/api/admin/dispatch-job').set('Authorization', `Bearer ${testAdminToken}`).send({ shortId: 'job_test_1' });
    assert(r1.status === 403 && r1.body.error === expectedErrorMsg, '1. POST /api/admin/dispatch-job blocked with 403');

    // 2. /api/admin/reconcile-job
    const r2 = await request(app).post('/api/admin/reconcile-job').set('Authorization', `Bearer ${testAdminToken}`).send({ shortId: 'job_test_1' });
    assert(r2.status === 403 && r2.body.error === expectedErrorMsg, '2. POST /api/admin/reconcile-job blocked with 403');

    // 3. /api/admin/pricing
    const r3 = await request(app).post('/api/admin/pricing').set('Authorization', `Bearer ${testAdminToken}`).send({ bwsingle: 2 });
    assert(r3.status === 403 && r3.body.error === expectedErrorMsg, '3. POST /api/admin/pricing blocked with 403');

    // 4. /api/admin/business-profile
    const r4 = await request(app).put('/api/admin/business-profile').set('Authorization', `Bearer ${testAdminToken}`).send({ legalName: 'Test' });
    assert(r4.status === 403 && r4.body.error === expectedErrorMsg, '4. PUT /api/admin/business-profile blocked with 403');

    // 5. /api/admin/refunds
    const r5 = await request(app).post('/api/admin/refunds').set('Authorization', `Bearer ${testAdminToken}`).send({ paymentId: 'p_1', amount: 10 });
    assert(r5.status === 403 && r5.body.error === expectedErrorMsg, '5. POST /api/admin/refunds blocked with 403');

    // 6. /api/admin/reconciliation/run
    const r6 = await request(app).post('/api/admin/reconciliation/run').set('Authorization', `Bearer ${testAdminToken}`).send({});
    assert(r6.status === 403 && r6.body.error === expectedErrorMsg, '6. POST /api/admin/reconciliation/run blocked with 403');

    // 7. /api/admin/reconciliation/:id/resolve
    const r7 = await request(app).post('/api/admin/reconciliation/123/resolve').set('Authorization', `Bearer ${testAdminToken}`).send({ notes: 'test' });
    assert(r7.status === 403 && r7.body.error === expectedErrorMsg, '7. POST /api/admin/reconciliation/:id/resolve blocked with 403');

    // 8. /api/machines (POST)
    const r8 = await request(app).post('/api/machines').set('Authorization', `Bearer ${testAdminToken}`).send({ name: 'New Kiosk', location: 'Lab' });
    assert(r8.status === 403 && r8.body.error === expectedErrorMsg, '8. POST /api/machines blocked with 403');

    // 9. /api/machines/:id (PUT)
    const r9 = await request(app).put(`/api/machines/${machine.id}`).set('Authorization', `Bearer ${testAdminToken}`).send({ name: 'Renamed' });
    assert(r9.status === 403 && r9.body.error === expectedErrorMsg, '9. PUT /api/machines/:id blocked with 403');

    // 10. /api/companies (POST)
    const r10 = await request(app).post('/api/companies').set('Authorization', `Bearer ${testAdminToken}`).send({ name: 'New Franchise' });
    assert(r10.status === 403 && r10.body.error === expectedErrorMsg, '10. POST /api/companies blocked with 403');

    // 11. /api/jobs/:id/status (PUT)
    const r11 = await request(app).put('/api/jobs/job_test_1/status').set('Authorization', `Bearer ${testAdminToken}`).send({ status: 'COMPLETED' });
    assert(r11.status === 403 && r11.body.error === expectedErrorMsg, '11. PUT /api/jobs/:id/status blocked with 403');

    // 12. /api/payments/refund/:id (POST)
    const r12 = await request(app).post('/api/payments/refund/p_1').set('Authorization', `Bearer ${testAdminToken}`).send({ amount: 10 });
    assert(r12.status === 403 && r12.body.error === expectedErrorMsg, '12. POST /api/payments/refund/:id blocked with 403');

    // 13. /api/subscriptions (POST)
    const r13 = await request(app).post('/api/subscriptions').set('Authorization', `Bearer ${testAdminToken}`).send({ machineId: 'm_1' });
    assert(r13.status === 403 && r13.body.error === expectedErrorMsg, '13. POST /api/subscriptions blocked with 403');

    // 14. /api/subscriptions/:id/cancel (POST)
    const r14 = await request(app).post('/api/subscriptions/sub_1/cancel').set('Authorization', `Bearer ${testAdminToken}`).send({ reason: 'test' });
    assert(r14.status === 403 && r14.body.error === expectedErrorMsg, '14. POST /api/subscriptions/:id/cancel blocked with 403');

    // ------------------------------------------------------------------
    // TEST 6: Preservation of Customer & Printer Agent Workflows
    // ------------------------------------------------------------------
    console.log('\n--- 6. Testing Customer & Agent Route Preservation ---');

    // Customer Session Creation (must not be blocked by read-only guard)
    const sessionRes = await request(app)
      .post('/api/auth/session/create')
      .send({ machineId: machine.id });
    assert(sessionRes.status === 200, `Customer session create allowed (status: ${sessionRes.status})`);
    assert(Boolean(sessionRes.body.sessionToken), 'Customer received sessionToken');

    // Printer Agent Public Key Retrieval (must not be blocked by read-only guard)
    const pubKeyRes = await request(app)
      .get(`/api/machines/${machine.id}/public-key`);
    assert(pubKeyRes.status === 200, `Agent public key lookup allowed (status: ${pubKeyRes.status})`);

    // ------------------------------------------------------------------
    // TEST 7: Staging Printer Agent WebSocket Authentication & Telemetry
    // ------------------------------------------------------------------
    console.log('\n--- 7. Testing Staging Printer Agent WebSocket Authentication & Telemetry ---');

    // 7.1 Connection without credentials rejected
    await new Promise((resolve) => {
      const badSocket = ClientIo(testSocketUrl, {
        auth: {},
        transports: ['websocket'],
        reconnection: false
      });
      badSocket.on('connect_error', (err) => {
        assert(err.message.includes('Authentication error'), `Empty credentials rejected: ${err.message}`);
        badSocket.close();
        resolve();
      });
    });

    // 7.2 Connection with invalid machine key rejected
    await new Promise((resolve) => {
      const badSocket = ClientIo(testSocketUrl, {
        auth: { machineKey: 'invalid_staging_key' },
        transports: ['websocket'],
        reconnection: false
      });
      badSocket.on('connect_error', (err) => {
        assert(err.message.includes('Invalid machine key'), `Invalid machine key rejected: ${err.message}`);
        badSocket.close();
        resolve();
      });
    });

    // 7.3 Staging Agent Successful Connection & Registration
    let agentSocket = null;
    await new Promise((resolve) => {
      agentSocket = ClientIo(testSocketUrl, {
        auth: { machineKey: 'staging_machine_key_9f8e7d6c5b4a3210' },
        transports: ['websocket'],
        reconnection: false
      });

      agentSocket.on('printer_registered_success', (data) => {
        assert(data.machineId === machine.id, `Agent registered with machine ID: ${data.machineId}`);
        assert(data.name === 'PrintGo Staging Virtual Kiosk', `Agent registered with name: ${data.name}`);
        resolve();
      });
    });

    // 7.4 Staging Agent Heartbeat
    await new Promise((resolve) => {
      agentSocket.emit('heartbeat');
      setTimeout(async () => {
        const updatedMachine = await prisma.machine.findUnique({ where: { id: machine.id } });
        assert(Boolean(updatedMachine.lastOnline), 'Machine lastOnline timestamp updated by heartbeat');
        resolve();
      }, 300);
    });

    // 7.5 Staging Agent Printer Status Telemetry
    await new Promise((resolve) => {
      agentSocket.emit('printer_status_update', {
        isError: false,
        errorMessage: null,
        statusText: 'Ready (Staging Mock)'
      });

      setTimeout(async () => {
        const statusRecord = await prisma.printerStatus.findFirst({
          where: { machineId: machine.id },
          orderBy: { createdAt: 'desc' }
        });
        assert(Boolean(statusRecord), 'PrinterStatus telemetry record created in staging DB');
        assert(statusRecord?.isOnline === true, 'Telemetry reports isOnline=true');
        assert(statusRecord?.paperStatus === 'OK', 'Telemetry reports paperStatus=OK');
        resolve();
      }, 300);
    });

    // 7.6 Staging Agent Disconnect & Reconnect Drill
    await new Promise((resolve) => {
      agentSocket.disconnect();
      setTimeout(() => {
        const reconnectedSocket = ClientIo(testSocketUrl, {
          auth: { machineKey: 'staging_machine_key_9f8e7d6c5b4a3210' },
          transports: ['websocket'],
          reconnection: false
        });

        reconnectedSocket.on('printer_registered_success', (data) => {
          assert(data.machineId === machine.id, 'Agent reconnected and re-registered successfully');
          reconnectedSocket.close();
          resolve();
        });
      }, 200);
    });

    // ------------------------------------------------------------------
    // TEST 8: Historical Job ab36197e Dispatch Guard Verification
    // ------------------------------------------------------------------
    console.log('\n--- 8. Testing Dispatch Guard for Historical Baseline Job ab36197e ---');
    // Temporarily disable read-only guard check to confirm baseline guard itself works
    process.env.ADMIN_READ_ONLY = 'false';
    const dispatchAb = await request(app)
      .post('/api/admin/dispatch-job')
      .set('Authorization', `Bearer ${testAdminToken}`)
      .send({ shortId: 'ab36197e' });

    assert(dispatchAb.status === 400, `Dispatching ab36197e rejected with 400 (actual: ${dispatchAb.status})`);
    assert(dispatchAb.body.error.includes('Historical baseline job ab36197e is protected'), 'ab36197e dispatch guard message confirmed');
    process.env.ADMIN_READ_ONLY = 'true'; // Restore read-only

    // ------------------------------------------------------------------
    // TEST 9: Customer-Facing Branding Preservation & Isolation Check
    // ------------------------------------------------------------------
    console.log('\n--- 9. Testing Customer-Facing Branding Preservation & Isolation ---');
    const businessProfileCount = await prisma.businessProfile.count();
    assert(businessProfileCount === 0, `BusinessProfile remains untouched in staging DB (count: ${businessProfileCount})`);

    // Verify existing kiosk files are preserved untouched
    const kioskSrc = fs.readFileSync(path.resolve('frontend/src/pages/KioskView.jsx'), 'utf8');
    assert(kioskSrc.includes('Step1Scan') && kioskSrc.includes('acquireSession'), 'KioskView code preserved intact');

    // ------------------------------------------------------------------
    // TEST 10: Frontend Admin-Only Mode Routing Logic
    // ------------------------------------------------------------------
    console.log('\n--- 10. Testing Frontend Admin-Only Mode Configuration ---');
    const appSrc = fs.readFileSync(path.resolve('frontend/src/App.jsx'), 'utf8');
    assert(appSrc.includes("isAdminOnlyMode = import.meta.env.VITE_APP_MODE === 'admin'"), 'App.jsx reads VITE_APP_MODE === admin');
    assert(appSrc.includes('<Route path="*" element={<AdminDashboard />} />'), 'App.jsx redirects all wildcard routes to AdminDashboard in admin mode');

  } finally {
    if (testHttpServer) {
      await new Promise(resolve => testHttpServer.close(resolve));
    }
    await prisma.$disconnect();
  }

  console.log('\n======================================================================');
  console.log(`GATE 2A TEST RESULTS: ${passedCount} PASSED, ${failedCount} FAILED (Total: ${passedCount + failedCount})`);
  console.log('======================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
