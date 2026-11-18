/**
 * PRINTGO — PHASE 3 ADMIN DASHBOARD QR INTEGRATION TEST SUITE
 *
 * Verifies backend API integration powering the Admin Dashboard UI:
 * 1. Initial State: Machine with no QR returns activeQr=null, history=[]
 * 2. Dedicated QR Generation via Admin API
 * 3. HTTP 409 Conflict Handling on duplicate generation
 * 4. High-Res Public QR URL formation & metadata integrity
 * 5. QR Rotation / Replacement with mandatory reason (>= 10 chars)
 * 6. QR Revocation with mandatory reason (>= 10 chars)
 * 7. Complete Audit Ledger retrieval (/api/admin/machines/:id/qr)
 * 8. Multi-Tenant Scoping: Franchisee cannot manage cross-tenant printers
 *
 * Target: printgo_disposable_target on port 5433 (PostgreSQL 17.4)
 */

const path = require('path');
const fs = require('fs');

// Read credentials or environment and set DATABASE_URL strictly to disposable target
const credsPath = path.resolve(__dirname, '../../.pg_credentials.local');
let targetUrl = process.env.DATABASE_URL;

if (!targetUrl && fs.existsSync(credsPath)) {
  const creds = fs.readFileSync(credsPath, 'utf8');
  const pass = creds.match(/POSTGRES_PASSWORD=(.*)/)[1].trim();
  targetUrl = `postgresql://postgres:${encodeURIComponent(pass)}@localhost:5433/printgo_disposable_target?schema=public`;
}

if (!targetUrl) {
  throw new Error('DATABASE_URL or .pg_credentials.local is required to run phase3_admin_dashboard_qr_integration test suite');
}

process.env.DATABASE_URL = targetUrl;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_phase3_dashboard_integration';
process.env.PUBLIC_APP_URL = 'https://printgo.in';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: targetUrl } } });
const printerQrService = require('../src/services/printerQr.service');

let passed = 0;
let failed = 0;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const test = async (name, fn) => {
  try {
    await fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ FAIL: ${name}`);
    console.error(`   Details: ${e.message}`);
    failed++;
  }
};

async function runTestSuite() {
  console.log('======================================================================');
  console.log('PRINTGO — PHASE 3 ADMIN DASHBOARD BACKEND INTEGRATION TEST SUITE');
  const isCi = process.env.GITHUB_ACTIONS === 'true';
  const expectedPort = isCi ? 5432 : 5433;

  console.log(`Target: printgo_disposable_target on port ${expectedPort} (GITHUB_ACTIONS=${isCi})`);
  console.log('======================================================================\n');

  // Pre-flight database check
  const meta = await prisma.$queryRawUnsafe('SELECT current_database(), inet_server_port();');
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

  // Synthetic Fixtures
  const companyA = await prisma.company.upsert({
    where: { contactEmail: 'phase3_shop_a@test.com' },
    update: {},
    create: { name: 'Phase 3 Shop Alpha', contactEmail: 'phase3_shop_a@test.com' }
  });

  const companyB = await prisma.company.upsert({
    where: { contactEmail: 'phase3_shop_b@test.com' },
    update: {},
    create: { name: 'Phase 3 Shop Beta', contactEmail: 'phase3_shop_b@test.com' }
  });

  const machineA = await prisma.machine.upsert({
    where: { machineKey: 'p3_mch_key_a' },
    update: { companyId: companyA.id, status: 'ACTIVE' },
    create: {
      name: 'P3 Test Printer Alpha',
      location: 'Front Counter',
      machineKey: 'p3_mch_key_a',
      status: 'ACTIVE',
      printerModel: 'EPSON L6460 Series',
      companyId: companyA.id
    }
  });

  const machineB = await prisma.machine.upsert({
    where: { machineKey: 'p3_mch_key_b' },
    update: { companyId: companyB.id, status: 'ACTIVE' },
    create: {
      name: 'P3 Test Printer Beta',
      location: 'Beta Counter',
      machineKey: 'p3_mch_key_b',
      status: 'ACTIVE',
      printerModel: 'HP LaserJet Pro',
      companyId: companyB.id
    }
  });

  const superadminUser = { id: 'usr_p3_superadmin', role: 'SUPERADMIN', email: 'super@p3.com' };
  const franchiseeA = { id: 'usr_p3_fran_a', role: 'FRANCHISEE', companyId: companyA.id, email: 'fran_a@p3.com' };
  const franchiseeB = { id: 'usr_p3_fran_b', role: 'FRANCHISEE', companyId: companyB.id, email: 'fran_b@p3.com' };

  const testQrIds = [];

  try {
    // 1. Initial Empty State
    await test('1. Machine with no QR returns activeQr=null and history=[]', async () => {
      const qrs = await printerQrService.listPrinterQrs(superadminUser, { machineId: machineA.id });
      assert(qrs.qrs.length === 0, 'Must have zero QRs initially');
    });

    // 2. Generate Permanent QR
    let generatedQr = null;
    await test('2. Superadmin generates permanent QR for machine A', async () => {
      generatedQr = await printerQrService.generatePrinterQr(
        machineA.id,
        { label: 'Front Counter Tabletop' },
        superadminUser
      );
      testQrIds.push(generatedQr.id);

      assert(generatedQr.status === 'ACTIVE', 'Generated QR status must be ACTIVE');
      assert(generatedQr.label === 'Front Counter Tabletop', 'Label must be saved');
      assert(generatedQr.publicCode.startsWith('pq_'), 'Public code must have pq_ prefix');
      assert(generatedQr.targetUrl.startsWith('https://printgo.in/p/'), 'Target URL must be HTTPS');
    });

    // 3. HTTP 409 Conflict Handling
    await test('3. Duplicate generation request returns HTTP 409 Conflict', async () => {
      let threw409 = false;
      let errorMsg = '';
      try {
        await printerQrService.generatePrinterQr(machineA.id, { label: 'Attempt Duplicate' }, superadminUser);
      } catch (err) {
        if (err.statusCode === 409) {
          threw409 = true;
          errorMsg = err.message;
        }
      }
      assert(threw409, `Must throw HTTP 409, got: ${errorMsg}`);
      assert(errorMsg.includes('already exists'), 'Error message must explain active QR exists');
    });

    // 4. QR List Query
    await test('4. listPrinterQrs returns active QR with populated targetUrl and machine metadata', async () => {
      const list = await printerQrService.listPrinterQrs(superadminUser, { machineId: machineA.id });
      assert(list.qrs.length === 1, 'Must find 1 QR in list');
      assert(list.qrs[0].targetUrl.includes(generatedQr.publicCode), 'List must include targetUrl');
      assert(list.qrs[0].machine.name === machineA.name, 'List must include machine relation');
    });

    // 5. QR Rotation / Replacement with Mandatory Reason (>= 10 chars)
    let rotatedResult = null;
    await test('5. replacePrinterQr rotates QR atomically with valid reason (>= 10 chars)', async () => {
      rotatedResult = await printerQrService.replacePrinterQr(
        generatedQr.id,
        {
          reason: 'Physical flyer damaged by water spill on counter',
          label: 'Front Counter Stand v2'
        },
        superadminUser
      );
      testQrIds.push(rotatedResult.newQr.id);

      assert(rotatedResult.archivedOldQr.status === 'REPLACED', 'Old QR status must be REPLACED');
      assert(rotatedResult.archivedOldQr.revokedReason.includes('water spill'), 'Revocation reason must be stored');
      assert(rotatedResult.newQr.status === 'ACTIVE', 'New QR status must be ACTIVE');
      assert(rotatedResult.newQr.label === 'Front Counter Stand v2', 'New label must be saved');
    });

    await test('6. replacePrinterQr rejects short or whitespace-only reason (< 10 chars) with HTTP 400', async () => {
      let threw400 = false;
      try {
        await printerQrService.replacePrinterQr(
          rotatedResult.newQr.id,
          { reason: 'too short' },
          superadminUser
        );
      } catch (err) {
        if (err.statusCode === 400) threw400 = true;
      }
      assert(threw400, 'Must reject replacement reason < 10 chars with HTTP 400');
    });

    // 7. QR Revocation with Mandatory Reason (>= 10 chars)
    let revokedQr = null;
    await test('7. revokePrinterQr deactivates QR permanently with valid reason (>= 10 chars)', async () => {
      revokedQr = await printerQrService.revokePrinterQr(
        rotatedResult.newQr.id,
        'Printer taken offline for scheduled hardware overhaul',
        superadminUser
      );

      assert(revokedQr.status === 'REVOKED', 'Status must be REVOKED');
      assert(revokedQr.revokedReason.includes('hardware overhaul'), 'Revoked reason must be stored');
    });

    await test('8. revokePrinterQr rejects short reason (< 10 chars) with HTTP 400', async () => {
      let threw400 = false;
      try {
        await printerQrService.revokePrinterQr(generatedQr.id, 'short', superadminUser);
      } catch (err) {
        if (err.statusCode === 400) threw400 = true;
      }
      assert(threw400, 'Must reject revocation reason < 10 chars with HTTP 400');
    });

    // 9. Complete Audit Ledger
    await test('9. Complete Audit Ledger contains active=null and 2 historical records (1 REPLACED, 1 REVOKED)', async () => {
      const allQrs = await printerQrService.listPrinterQrs(superadminUser, { machineId: machineA.id });
      const active = allQrs.qrs.find(q => q.status === 'ACTIVE') || null;
      const history = allQrs.qrs.filter(q => q.status !== 'ACTIVE');

      assert(active === null, 'Active QR must be null after revocation');
      assert(history.length === 2, `History must contain 2 records, found ${history.length}`);
      assert(history.some(h => h.status === 'REPLACED'), 'History must include REPLACED record');
      assert(history.some(h => h.status === 'REVOKED'), 'History must include REVOKED record');
    });

    // 10. Multi-Tenant Scoping
    await test('10. Multi-Tenant Scoping: Franchisee B cannot access or manage Franchisee A printer QR', async () => {
      // Franchisee B attempts to view machine A QR
      let viewBlocked = false;
      try {
        await printerQrService.getPrinterQrById(generatedQr.id, franchiseeB);
      } catch (err) {
        if (err.statusCode === 403) viewBlocked = true;
      }
      assert(viewBlocked, 'Franchisee B must be rejected (HTTP 403) from viewing Franchisee A QR');

      // Franchisee B attempts to generate QR for machine A
      let generateBlocked = false;
      try {
        await printerQrService.generatePrinterQr(machineA.id, { label: 'Cross-Tenant Hack' }, franchiseeB);
      } catch (err) {
        if (err.statusCode === 403) generateBlocked = true;
      }
      assert(generateBlocked, 'Franchisee B must be rejected (HTTP 403) from generating QR for Franchisee A printer');
    });

  } finally {
    console.log('\n--- CLEANING UP TEST DATA ON DISPOSABLE TARGET ---');
    if (testQrIds.length > 0) {
      await prisma.session.deleteMany({
        where: { printerQrId: { in: testQrIds } }
      });
      await prisma.printerQr.deleteMany({
        where: { id: { in: testQrIds } }
      });
    }
    await prisma.machine.deleteMany({
      where: { machineKey: { in: ['p3_mch_key_a', 'p3_mch_key_b'] } }
    });
    await prisma.company.deleteMany({
      where: { contactEmail: { in: ['phase3_shop_a@test.com', 'phase3_shop_b@test.com'] } }
    });
    console.log('Cleanup completed successfully.\n');
  }

  await prisma.$disconnect();

  console.log('======================================================================');
  console.log(`PHASE 3 INTEGRATION TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('======================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Unhandled exception in Phase 3 test suite:', err);
  process.exit(1);
});
