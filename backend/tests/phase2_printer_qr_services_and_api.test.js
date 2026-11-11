/**
 * PRINTGO — PHASE 2 AUTOMATED TEST SUITE
 * Permanent Printer QR Backend Services, Lifecycle & API Security
 *
 * MANDATORY SAFETY ENFORCEMENT:
 * Strictly bound to printgo_disposable_target on port 5433.
 */

const path = require('path');
const fs = require('fs');

// Read credentials and set DATABASE_URL strictly to printgo_disposable_target
const creds = fs.readFileSync(path.resolve(__dirname, '../../.pg_credentials.local'), 'utf8');
const pass = creds.match(/POSTGRES_PASSWORD=(.*)/)[1].trim();
const targetUrl = `postgresql://postgres:${encodeURIComponent(pass)}@localhost:5433/printgo_disposable_target?schema=public`;

process.env.DATABASE_URL = targetUrl;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_phase2_isolated_testing';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: targetUrl } } });

const printerQrService = require('../src/services/printerQr.service');
const authController = require('../src/modules/auth/auth.controller');
const printerQrAdminController = require('../src/modules/admin/printerQr.admin.controller');
const jwt = require('jsonwebtoken');

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

async function runTestSuite() {
  console.log('======================================================================');
  console.log('PRINTGO — PHASE 2 PERMANENT PRINTER QR TEST SUITE');
  console.log('Target: printgo_disposable_target on port 5433 (PostgreSQL 17.4)');
  console.log('======================================================================\n');

  // MANDATORY PRE-FLIGHT DATABASE VERIFICATION
  const meta = await prisma.$queryRawUnsafe('SELECT current_database(), inet_server_port(), version()');
  const dbName = meta[0].current_database;
  const dbPort = meta[0].inet_server_port;

  console.log(`Pre-flight Database Check: ${dbName} on port ${dbPort}`);
  if (dbName !== 'printgo_disposable_target') {
    console.error('FATAL SAFETY VIOLATION: Database is not printgo_disposable_target! Aborting immediately.');
    process.exit(1);
  }
  if (dbPort !== 5433) {
    console.error('FATAL SAFETY VIOLATION: Port is not 5433! Aborting immediately.');
    process.exit(1);
  }
  console.log('Pre-flight Safety Check PASSED: Strictly isolated to printgo_disposable_target.\n');

  // SETUP: Ensure test machines & test companies exist for multi-tenancy testing
  const companyA = await prisma.company.upsert({
    where: { contactEmail: 'shop_a_franchisee@test.com' },
    update: {},
    create: { name: 'Shop Alpha Franchisee', contactEmail: 'shop_a_franchisee@test.com' }
  });

  const companyB = await prisma.company.upsert({
    where: { contactEmail: 'shop_b_franchisee@test.com' },
    update: {},
    create: { name: 'Shop Beta Franchisee', contactEmail: 'shop_b_franchisee@test.com' }
  });

  const userSuperadmin = { id: 'usr_superadmin', role: 'SUPERADMIN', email: 'superadmin@printgo.in' };
  const userFranchiseeA = { id: 'usr_franchisee_a', role: 'FRANCHISEE', companyId: companyA.id, email: 'owner@shopa.com' };
  const userFranchiseeB = { id: 'usr_franchisee_b', role: 'FRANCHISEE', companyId: companyB.id, email: 'owner@shopb.com' };

  // Synthetic Test Machines
  const machineA = await prisma.machine.upsert({
    where: { machineKey: 'test_machine_key_phase2_a' },
    update: { companyId: companyA.id, status: 'ACTIVE' },
    create: {
      name: 'Printer Alpha Active',
      location: 'Counter 1',
      machineKey: 'test_machine_key_phase2_a',
      status: 'ACTIVE',
      printerModel: 'Canon G3010',
      companyId: companyA.id
    }
  });

  const machineA2 = await prisma.machine.upsert({
    where: { machineKey: 'test_machine_key_phase2_a2' },
    update: { companyId: companyA.id, status: 'ACTIVE' },
    create: {
      name: 'Printer Alpha 2 Active',
      location: 'Counter 2',
      machineKey: 'test_machine_key_phase2_a2',
      status: 'ACTIVE',
      printerModel: 'Canon G3010',
      companyId: companyA.id
    }
  });

  const machineRevoke = await prisma.machine.upsert({
    where: { machineKey: 'test_machine_key_phase2_revoke' },
    update: { companyId: companyA.id, status: 'ACTIVE' },
    create: {
      name: 'Printer Revoke Test',
      location: 'Counter Revoke',
      machineKey: 'test_machine_key_phase2_revoke',
      status: 'ACTIVE',
      printerModel: 'Epson EcoTank',
      companyId: companyA.id
    }
  });

  const machineB = await prisma.machine.upsert({
    where: { machineKey: 'test_machine_key_phase2_b' },
    update: { companyId: companyB.id, status: 'ACTIVE' },
    create: {
      name: 'Printer Beta Active',
      location: 'Counter 2',
      machineKey: 'test_machine_key_phase2_b',
      status: 'ACTIVE',
      printerModel: 'HP LaserJet Pro',
      companyId: companyB.id
    }
  });

  const machineSuspended = await prisma.machine.upsert({
    where: { machineKey: 'test_machine_key_phase2_suspended' },
    update: { status: 'SUSPENDED' },
    create: {
      name: 'Printer Suspended',
      location: 'Back Office',
      machineKey: 'test_machine_key_phase2_suspended',
      status: 'SUSPENDED',
      companyId: companyA.id
    }
  });

  // Track created test QRs for cleanup
  const testQrIds = [];

  console.log('--- GROUP A: TOKEN SECURITY & PUBLIC URL VALIDATION ---');

  await test('A1: Token format and cryptographic entropy', async () => {
    const token = printerQrService.generateSecurePublicCode();
    assert(token.startsWith('pq_'), 'Token must start with pq_ prefix');
    const rawPart = token.slice(3);
    assert(rawPart.length >= 40, 'Token raw part must have at least 32 bytes of Base64URL entropy (>= 43 chars)');
    assert(/^[a-zA-Z0-9_-]+$/.test(rawPart), 'Token must be strictly URL-safe');
  });

  await test('A2: High-entropy uniqueness (1,000 generated tokens without collision)', async () => {
    const set = new Set();
    const count = 1000;
    for (let i = 0; i < count; i++) {
      const code = printerQrService.generateSecurePublicCode();
      assert(!set.has(code), `Collision detected on iteration ${i} for code ${code}`);
      set.add(code);
    }
    assert(set.size === count, 'All 1,000 tokens must be strictly unique');
  });

  await test('A3: URL validation enforces HTTPS and rejects private IP in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalUrl = process.env.PUBLIC_APP_URL;

    try {
      process.env.NODE_ENV = 'production';

      // Test localhost rejection
      process.env.PUBLIC_APP_URL = 'http://localhost:5173';
      let threwLocalhost = false;
      try {
        printerQrService.getPublicQrUrl('test_code');
      } catch (err) {
        threwLocalhost = true;
      }
      assert(threwLocalhost, 'Production must reject http://localhost');

      // Test private LAN IP rejection
      process.env.PUBLIC_APP_URL = 'https://192.168.1.5:5173';
      let threwPrivateIp = false;
      try {
        printerQrService.getPublicQrUrl('test_code');
      } catch (err) {
        threwPrivateIp = true;
      }
      assert(threwPrivateIp, 'Production must reject private LAN IPs even with HTTPS');

      // Test valid public HTTPS URL
      process.env.PUBLIC_APP_URL = 'https://printgo.in';
      const validUrl = printerQrService.getPublicQrUrl('test_code_123');
      assert(validUrl === 'https://printgo.in/p/test_code_123', 'Valid public HTTPS URL must resolve correctly');

      // Test missing URL in production (fails closed)
      delete process.env.PUBLIC_APP_URL;
      delete process.env.PUBLIC_FRONTEND_URL;
      delete process.env.FRONTEND_URL;
      let threwMissing = false;
      try {
        printerQrService.getPublicQrUrl('test_code');
      } catch (err) {
        threwMissing = true;
      }
      assert(threwMissing, 'Production must fail closed if PUBLIC_APP_URL is missing');
    } finally {
      process.env.NODE_ENV = originalEnv;
      process.env.PUBLIC_APP_URL = originalUrl || 'https://printgo.in';
    }
  });

  console.log('\n--- GROUP B: DEDICATED QR GENERATION & TENANT BINDING ---');

  let activeQrA = null;
  await test('B1: Superadmin generates active dedicated QR for Printer A', async () => {
    activeQrA = await printerQrService.generatePrinterQr(machineA.id, { label: 'Front Counter Master' }, userSuperadmin);
    testQrIds.push(activeQrA.id);

    assert(activeQrA.id, 'Created QR must have a database UUID');
    assert(activeQrA.publicCode.startsWith('pq_'), 'Created QR must have secure pq_ code');
    assert(activeQrA.status === 'ACTIVE', 'Created QR must have status ACTIVE');
    assert(activeQrA.machineId === machineA.id, 'QR must be bound to Printer A');
    assert(activeQrA.targetUrl.includes(activeQrA.publicCode), 'Target URL must include public code');
  });

  await test('B2: Franchisee A generates dedicated QR for own Printer A2', async () => {
    const qrFranchiseeA = await printerQrService.generatePrinterQr(machineA2.id, { label: 'Side Pedestal' }, userFranchiseeA);
    testQrIds.push(qrFranchiseeA.id);

    assert(qrFranchiseeA.machineId === machineA2.id, 'Franchisee must successfully generate QR for owned machine');
  });

  await test('B3: Tenant isolation: Franchisee B CANNOT generate QR for Franchisee A printer', async () => {
    let accessDenied = false;
    try {
      await printerQrService.generatePrinterQr(machineA.id, { label: 'Unauthorized Attempt' }, userFranchiseeB);
    } catch (err) {
      if (err.statusCode === 403 || err.message.includes('Access denied')) {
        accessDenied = true;
      }
    }
    assert(accessDenied, 'Franchisee B must be rejected when attempting to manage Franchisee A machine');
  });

  await test('B4: Cannot generate QR for non-existent machine (404)', async () => {
    let notFound = false;
    try {
      await printerQrService.generatePrinterQr('00000000-0000-0000-0000-000000000000', {}, userSuperadmin);
    } catch (err) {
      if (err.statusCode === 404) notFound = true;
    }
    assert(notFound, 'Non-existent machine must return 404');
  });

  await test('B5: Cannot generate QR for suspended machine (400)', async () => {
    let suspendedBlocked = false;
    try {
      await printerQrService.generatePrinterQr(machineSuspended.id, {}, userSuperadmin);
    } catch (err) {
      if (err.statusCode === 400 || err.message.includes('suspended')) suspendedBlocked = true;
    }
    assert(suspendedBlocked, 'Suspended machine must be rejected for QR generation');
  });

  console.log('\n--- GROUP C: CUSTOMER DYNAMIC SESSION RESOLUTION ---');

  let session1Result = null;
  await test('C1: Customer scans active QR: creates fresh 60-minute session', async () => {
    session1Result = await printerQrService.resolvePrinterQr(activeQrA.publicCode);

    assert(session1Result.success === true, 'Session resolution must return success: true');
    assert(session1Result.sessionCode, 'Must return ephemeral sessionCode');
    assert(session1Result.sessionToken, 'Must return signed sessionToken');
    assert(session1Result.printer.name === machineA.name, 'Must return target printer name');
    assert(session1Result.printer.isOnline === true, 'Printer must be reported online');

    // Verify session in database
    const dbSession = await prisma.session.findUnique({ where: { code: session1Result.sessionCode } });
    assert(dbSession, 'Session must exist in database');
    assert(dbSession.machineId === machineA.id, 'Session machineId must match target printer');
    assert(dbSession.printerQrId === activeQrA.id, 'Session must be linked to printerQrId');

    // Verify 60-minute TTL (between 58 and 62 mins from now)
    const ttlMins = (new Date(dbSession.expiresAt).getTime() - Date.now()) / (60 * 1000);
    assert(ttlMins >= 58 && ttlMins <= 62, 'Session TTL must be approximately 60 minutes');
  });

  await test('C2: Next customer scans SAME physical QR: receives completely fresh session', async () => {
    const session2Result = await printerQrService.resolvePrinterQr(activeQrA.publicCode);

    assert(session2Result.sessionCode !== session1Result.sessionCode, 'Second scan must produce distinct sessionCode');
    assert(session2Result.sessionToken !== session1Result.sessionToken, 'Second scan must produce distinct sessionToken');

    // Both sessions point to same printer
    const dbSession2 = await prisma.session.findUnique({ where: { code: session2Result.sessionCode } });
    assert(dbSession2.machineId === machineA.id, 'Second session must still bind to Printer A');
    assert(dbSession2.printerQrId === activeQrA.id, 'Second session must link to same physical QR');
  });

  await test('C3: Session JWT token verification and payload integrity', async () => {
    const decoded = jwt.verify(session1Result.sessionToken, process.env.JWT_SECRET);
    assert(decoded.sessionId === session1Result.sessionCode, 'JWT sessionId must match sessionCode');
    assert(decoded.machineId === machineA.id, 'JWT machineId must match target printer');
    assert(decoded.type === 'session', 'JWT type must be session');
    assert(decoded.role === 'mobile', 'JWT role must be mobile');
  });

  await test('C4: Resolving non-existent QR code returns 404', async () => {
    let notFound = false;
    try {
      await printerQrService.resolvePrinterQr('pq_completely_unknown_token_9999');
    } catch (err) {
      if (err.statusCode === 404) notFound = true;
    }
    assert(notFound, 'Unknown public code must return 404');
  });

  console.log('\n--- GROUP D: QR ROTATION, REVOCATION & AUDIT LIFECYCLE ---');

  let qrToRotate = null;
  await test('D1: Revocation requires meaningful reason (>= 10 chars)', async () => {
    qrToRotate = await printerQrService.generatePrinterQr(machineRevoke.id, { label: 'To Be Revoked' }, userSuperadmin);
    testQrIds.push(qrToRotate.id);

    // Empty reason
    let emptyBlocked = false;
    try {
      await printerQrService.revokePrinterQr(qrToRotate.id, '', userSuperadmin);
    } catch (err) {
      if (err.statusCode === 400) emptyBlocked = true;
    }
    assert(emptyBlocked, 'Empty revocation reason must be rejected');

    // Short reason (< 10 chars)
    let shortBlocked = false;
    try {
      await printerQrService.revokePrinterQr(qrToRotate.id, 'too short', userSuperadmin);
    } catch (err) {
      if (err.statusCode === 400) shortBlocked = true;
    }
    assert(shortBlocked, 'Short revocation reason (< 10 chars) must be rejected');
  });

  await test('D2: Successful QR revocation with audit metadata', async () => {
    const validReason = 'Physical flyer was damaged by spill and replaced';
    const revoked = await printerQrService.revokePrinterQr(qrToRotate.id, validReason, userSuperadmin);

    assert(revoked.status === 'REVOKED', 'Status must be updated to REVOKED');
    assert(revoked.revokedReason === validReason, 'Revoked reason must be stored in database');
    assert(revoked.revokedBy === userSuperadmin.id, 'Operator ID must be recorded');
    assert(revoked.revokedAt, 'Timestamp must be recorded');

    // Verify in database
    const dbQr = await prisma.printerQr.findUnique({ where: { id: qrToRotate.id } });
    assert(dbQr.status === 'REVOKED', 'Database record must show REVOKED');
  });

  await test('D3: Scanning a REVOKED QR code throws HTTP 410 Gone', async () => {
    let goneCaught = false;
    let goneMessage = '';
    try {
      await printerQrService.resolvePrinterQr(qrToRotate.publicCode);
    } catch (err) {
      if (err.statusCode === 410) {
        goneCaught = true;
        goneMessage = err.message;
      }
    }
    assert(goneCaught, 'Scanning revoked QR must throw HTTP 410');
    assert(goneMessage.includes('revoked'), 'Error message must inform customer the QR was revoked');
  });

  let replacementResult = null;
  await test('D4: QR replacement rotates token atomically and marks old as REPLACED', async () => {
    const qrToReplace = await printerQrService.generatePrinterQr(machineB.id, { label: 'Shop B Old Counter' }, userSuperadmin);
    testQrIds.push(qrToReplace.id);

    const replacementReason = 'Routine monthly security token rotation for Counter 2';
    replacementResult = await printerQrService.replacePrinterQr(qrToReplace.id, { replacementReason }, userSuperadmin);
    testQrIds.push(replacementResult.newQr.id);

    // Old QR checks
    assert(replacementResult.archivedOldQr.status === 'REPLACED', 'Old QR must transition to REPLACED');
    assert(replacementResult.archivedOldQr.revokedReason === replacementReason, 'Old QR must store rotation reason');

    // New QR checks
    assert(replacementResult.newQr.status === 'ACTIVE', 'New QR must be ACTIVE');
    assert(replacementResult.newQr.publicCode !== qrToReplace.publicCode, 'New QR must have a completely distinct token');
    assert(replacementResult.newQr.machineId === machineB.id, 'New QR must bind to the same machine');

    // Scanning OLD QR throws 410
    let oldCodeBlocked = false;
    try {
      await printerQrService.resolvePrinterQr(qrToReplace.publicCode);
    } catch (err) {
      if (err.statusCode === 410 && err.message.includes('replaced')) oldCodeBlocked = true;
    }
    assert(oldCodeBlocked, 'Old replaced QR code must reject scans with HTTP 410');

    // Scanning NEW QR succeeds
    const newScan = await printerQrService.resolvePrinterQr(replacementResult.newQr.publicCode);
    assert(newScan.success === true, 'New rotated QR code must resolve successfully');
    assert(newScan.printer.name === machineB.name, 'New QR must correctly route to Printer B');
  });

  console.log('\n--- GROUP E: ADMIN API ENDPOINTS & ROLE AUTHORIZATION ---');

  await test('E1: List QRs: Superadmin sees all; Franchisee scoped to company', async () => {
    const superList = await printerQrService.listPrinterQrs(userSuperadmin, {});
    assert(superList.qrs.length >= 2, 'Superadmin must see all active QRs');

    const franchAList = await printerQrService.listPrinterQrs(userFranchiseeA, {});
    const allBelongToA = franchAList.qrs.every(q => q.machine.companyId === companyA.id);
    assert(allBelongToA, 'Franchisee A list must strictly contain only machines from Company A');

    const franchBList = await printerQrService.listPrinterQrs(userFranchiseeB, {});
    const allBelongToB = franchBList.qrs.every(q => q.machine.companyId === companyB.id);
    assert(allBelongToB, 'Franchisee B list must strictly contain only machines from Company B');
  });

  await test('E2: Machine QR ledger endpoint returns active QR and historical records', async () => {
    // Mock req and res for controller call
    const req = {
      params: { id: machineB.id },
      user: userSuperadmin
    };
    let jsonResult = null;
    const res = {
      status: (code) => {
        assert(code === 200, 'Ledger endpoint must return HTTP 200');
        return {
          json: (data) => { jsonResult = data; }
        };
      }
    };
    const next = (err) => { if (err) throw err; };

    await printerQrAdminController.getMachineQrLedger(req, res, next);
    assert(jsonResult && jsonResult.success === true, 'Ledger must return success: true');
    assert(jsonResult.data.activeQr.publicCode === replacementResult.newQr.publicCode, 'Active QR must match newly rotated QR');
    assert(jsonResult.data.history.length >= 1, 'History must contain the replaced QR');
  });

  console.log('\n--- GROUP F: LEGACY COMPATIBILITY & REGRESSION ---');

  await test('F1: Legacy session join (/api/auth/session/join) remains 100% functional', async () => {
    // Verify existing demo session EPSON-DEMO-01
    const req = {
      body: { sessionCode: 'EPSON-DEMO-01' }
    };
    let jsonResult = null;
    const res = {
      status: (code) => {
        assert(code === 200, 'Legacy join must return 200');
        return {
          json: (data) => { jsonResult = data; }
        };
      }
    };
    const next = (err) => { if (err) throw err; };

    await authController.joinSession(req, res, next);
    assert(jsonResult && jsonResult.success === true, 'Legacy join must succeed');
    assert(jsonResult.sessionToken, 'Must return sessionToken');
    assert(jsonResult.machineId === 'a8b6164a-1c3f-46ab-b8ef-5cb2c3212d28', 'Must resolve to Epson L6460');
  });

  await test('F2: Public pre-scan metadata endpoint returns safe info without secrets', async () => {
    const info = await printerQrService.getPublicPrinterQrInfo(activeQrA.publicCode);
    assert(info.success === true, 'Pre-scan must return success');
    assert(info.printer.name === machineA.name, 'Must return printer name');
    assert(info.printer.model === machineA.printerModel, 'Must return printer model');
    assert(!info.machineId, 'Must NOT expose internal machine UUID');
    assert(!info.machineKey, 'Must NOT expose agent machineKey');
  });

  // CLEANUP: Clean synthetic QRs created during this test run
  console.log('\n--- CLEANING UP TEST DATA ON DISPOSABLE TARGET ---');
  await prisma.session.deleteMany({
    where: { printerQrId: { in: testQrIds } }
  });
  await prisma.printerQr.deleteMany({
    where: { id: { in: testQrIds } }
  });
  await prisma.machine.deleteMany({
    where: { machineKey: { in: ['test_machine_key_phase2_a', 'test_machine_key_phase2_a2', 'test_machine_key_phase2_revoke', 'test_machine_key_phase2_b', 'test_machine_key_phase2_suspended'] } }
  });
  await prisma.company.deleteMany({
    where: { contactEmail: { in: ['shop_a_franchisee@test.com', 'shop_b_franchisee@test.com'] } }
  });
  console.log('Test data cleaned up successfully.');

  await prisma.$disconnect();

  console.log('\n======================================================================');
  console.log(`PHASE 2 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('======================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('\nUNHANDLED EXCEPTION IN PHASE 2 TEST SUITE:', err);
  process.exit(1);
});
