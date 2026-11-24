/**
 * PRINTGO — PHASE 2.1 CONCURRENCY & SECURITY REMEDIATION TEST SUITE
 *
 * Verifies:
 * 1. Single ACTIVE QR Invariant (Concurrent generation rejection, DB partial unique index)
 * 2. Elimination of Revocation/Resolution TOCTOU Race via PostgreSQL Row Locking
 * 3. Orphaned QR Defensive Handling Across All Endpoints
 * 4. Explicit Replacement & Lifecycle State Transitions
 *
 * Target: printgo_disposable_target on port 5433 (PostgreSQL 17.4)
 */

const path = require('path');
const fs = require('fs');

// Read credentials and set DATABASE_URL strictly to printgo_disposable_target
const credsPath = path.resolve(__dirname, '../../.pg_credentials.local');
const creds = fs.readFileSync(credsPath, 'utf8');
const pass = creds.match(/POSTGRES_PASSWORD=(.*)/)[1].trim();
const targetUrl = `postgresql://postgres:${encodeURIComponent(pass)}@localhost:5433/printgo_disposable_target?schema=public`;

process.env.DATABASE_URL = targetUrl;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_phase2_1_remediation';

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
  console.log('PRINTGO — PHASE 2.1 SECURITY & CONCURRENCY REMEDIATION SUITE');
  console.log('Target: printgo_disposable_target on port 5433 (PostgreSQL 17.4)');
  console.log('======================================================================\n');

  // Pre-flight database check
  const meta = await prisma.$queryRawUnsafe('SELECT current_database(), inet_server_port();');
  const dbName = meta[0].current_database;
  const dbPort = meta[0].inet_server_port;

  console.log(`Pre-flight Database Check: ${dbName} on port ${dbPort}`);
  if (dbName !== 'printgo_disposable_target' || Number(dbPort) !== 5433) {
    console.error('FATAL SAFETY VIOLATION: Database is NOT printgo_disposable_target:5433! Aborting.');
    process.exit(1);
  }
  console.log('Pre-flight Safety Check PASSED: Strictly isolated to printgo_disposable_target.\n');

  // Fixtures
  const companyA = await prisma.company.upsert({
    where: { contactEmail: 'p21_shop_a@test.com' },
    update: {},
    create: { name: 'P2.1 Shop Alpha', contactEmail: 'p21_shop_a@test.com' }
  });

  const companyB = await prisma.company.upsert({
    where: { contactEmail: 'p21_shop_b@test.com' },
    update: {},
    create: { name: 'P2.1 Shop Beta', contactEmail: 'p21_shop_b@test.com' }
  });

  const machineA = await prisma.machine.upsert({
    where: { machineKey: 'p21_mch_key_a' },
    update: { companyId: companyA.id, status: 'ACTIVE' },
    create: {
      name: 'P2.1 Printer Alpha',
      location: 'Alpha Desk',
      machineKey: 'p21_mch_key_a',
      status: 'ACTIVE',
      printerModel: 'Canon G3010',
      companyId: companyA.id
    }
  });

  const machineB = await prisma.machine.upsert({
    where: { machineKey: 'p21_mch_key_b' },
    update: { companyId: companyB.id, status: 'ACTIVE' },
    create: {
      name: 'P2.1 Printer Beta',
      location: 'Beta Desk',
      machineKey: 'p21_mch_key_b',
      status: 'ACTIVE',
      printerModel: 'HP LaserJet Pro',
      companyId: companyB.id
    }
  });

  const superadminUser = { id: 'usr_p21_superadmin', role: 'SUPERADMIN', email: 'super@p21.com' };
  const franchiseeA = { id: 'usr_p21_fran_a', role: 'FRANCHISEE', companyId: companyA.id, email: 'fran_a@p21.com' };
  const franchiseeB = { id: 'usr_p21_fran_b', role: 'FRANCHISEE', companyId: companyB.id, email: 'fran_b@p21.com' };

  const testQrIds = [];
  const testSessionCodes = [];

  try {
    // ------------------------------------------------------------------
    // SECTION 1: SINGLE ACTIVE QR INVARIANT & CONCURRENT GENERATION
    // ------------------------------------------------------------------
    console.log('--- SECTION 1: SINGLE ACTIVE QR INVARIANT & CONCURRENT GENERATION ---');

    await test('1.1: 5 concurrent generation requests for one machine create EXACTLY ONE ACTIVE QR and 4 reject with HTTP 409', async () => {
      const calls = [
        printerQrService.generatePrinterQr(machineA.id, { label: 'Conc 1' }, superadminUser).catch(e => e),
        printerQrService.generatePrinterQr(machineA.id, { label: 'Conc 2' }, superadminUser).catch(e => e),
        printerQrService.generatePrinterQr(machineA.id, { label: 'Conc 3' }, superadminUser).catch(e => e),
        printerQrService.generatePrinterQr(machineA.id, { label: 'Conc 4' }, superadminUser).catch(e => e),
        printerQrService.generatePrinterQr(machineA.id, { label: 'Conc 5' }, superadminUser).catch(e => e)
      ];

      const outcomes = await Promise.all(calls);
      const successes = outcomes.filter(o => o && o.id && o.status === 'ACTIVE');
      const conflicts = outcomes.filter(o => o instanceof Error && o.statusCode === 409);

      successes.forEach(s => testQrIds.push(s.id));

      assert(successes.length === 1, `Expected exactly 1 success, got ${successes.length}`);
      assert(conflicts.length === 4, `Expected exactly 4 HTTP 409 conflicts, got ${conflicts.length}`);

      // Verify in database
      const activeInDb = await prisma.printerQr.findMany({
        where: { machineId: machineA.id, status: 'ACTIVE' }
      });
      assert(activeInDb.length === 1, `Database must contain exactly 1 ACTIVE record for machine, found ${activeInDb.length}`);
    });

    await test('1.2: Subsequent sequential generatePrinterQr call rejects with HTTP 409 conflict', async () => {
      let rejected = false;
      let statusCode = null;
      try {
        await printerQrService.generatePrinterQr(machineA.id, { label: 'Attempt Duplicate' }, superadminUser);
      } catch (e) {
        rejected = true;
        statusCode = e.statusCode;
      }
      assert(rejected && statusCode === 409, `Expected HTTP 409 conflict, got ${statusCode}`);
    });

    await test('1.3: PostgreSQL partial unique index enforces uniqueness at database engine level', async () => {
      // Attempt direct SQL bypass to insert duplicate ACTIVE record
      let dbRejected = false;
      let errorMsg = '';
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "PrinterQr" ("id", "publicCode", "label", "status", "machineId", "updatedAt")
           VALUES ($1, $2, 'DB Bypass Attempt', 'ACTIVE', $3, NOW())`,
          'synth_uuid_bypass_' + Date.now(),
          printerQrService.generateSecurePublicCode(),
          machineA.id
        );
      } catch (e) {
        dbRejected = true;
        errorMsg = e.message;
      }
      assert(dbRejected, 'Database must reject duplicate ACTIVE record via partial unique index');
      assert(
        errorMsg.includes('23505') || errorMsg.includes('already exists') || errorMsg.includes('printer_qrs_machine_id_active_unique') || errorMsg.includes('unique constraint'),
        `Error must reference partial unique index or code 23505, got: ${errorMsg}`
      );
    });

    await test('1.4: Multiple non-active (REVOKED / REPLACED) records are permitted for the same machineId', async () => {
      const code1 = printerQrService.generateSecurePublicCode();
      const code2 = printerQrService.generateSecurePublicCode();

      const r1 = await prisma.printerQr.create({
        data: { publicCode: code1, status: 'REVOKED', machineId: machineA.id, label: 'Revoked 1' }
      });
      const r2 = await prisma.printerQr.create({
        data: { publicCode: code2, status: 'REPLACED', machineId: machineA.id, label: 'Replaced 1' }
      });
      testQrIds.push(r1.id, r2.id);

      assert(r1.id && r2.id, 'Multiple non-active records must be allowed by partial index');
    });

    await test('1.5: Multiple NULL machineId records with status ACTIVE are permitted (excluding NULL machineId)', async () => {
      const codeNull1 = printerQrService.generateSecurePublicCode();
      const codeNull2 = printerQrService.generateSecurePublicCode();

      const n1 = await prisma.printerQr.create({
        data: { publicCode: codeNull1, status: 'ACTIVE', machineId: null, label: 'Orphan 1' }
      });
      const n2 = await prisma.printerQr.create({
        data: { publicCode: codeNull2, status: 'ACTIVE', machineId: null, label: 'Orphan 2' }
      });
      testQrIds.push(n1.id, n2.id);

      assert(n1.id && n2.id, 'Multiple NULL machineId records must be allowed by partial index');
    });

    // ------------------------------------------------------------------
    // SECTION 2: EXPLICIT REPLACEMENT OPERATION
    // ------------------------------------------------------------------
    console.log('\n--- SECTION 2: EXPLICIT REPLACEMENT OPERATION ---');

    let currentActiveQr = null;
    await test('2.1: replacePrinterQr rotates active QR atomically and updates old to REPLACED', async () => {
      const initialActive = await prisma.printerQr.findFirst({
        where: { machineId: machineA.id, status: 'ACTIVE' }
      });
      assert(initialActive, 'Must have an existing active QR');

      const result = await printerQrService.replacePrinterQr(
        initialActive.id,
        { reason: 'Upgraded to weatherproof acrylic flyer on front counter' },
        superadminUser
      );

      testQrIds.push(result.newQr.id);
      currentActiveQr = result.newQr;

      assert(result.archivedOldQr.status === 'REPLACED', 'Old QR status must be REPLACED');
      assert(result.archivedOldQr.revokedReason.includes('weatherproof'), 'Revoked reason must be stored');
      assert(result.newQr.status === 'ACTIVE', 'New QR status must be ACTIVE');
      assert(result.newQr.machineId === machineA.id, 'New QR must belong to machine A');

      // Verify exactly 1 active QR remains for machine A
      const countActive = await prisma.printerQr.count({
        where: { machineId: machineA.id, status: 'ACTIVE' }
      });
      assert(countActive === 1, `Exactly 1 active QR must exist after replacement, found ${countActive}`);
    });

    await test('2.2: Cannot replace an already REPLACED QR code (400)', async () => {
      const oldReplaced = await prisma.printerQr.findFirst({
        where: { machineId: machineA.id, status: 'REPLACED' }
      });

      let rejected = false;
      try {
        await printerQrService.replacePrinterQr(oldReplaced.id, { reason: 'Attempt duplicate replacement' }, superadminUser);
      } catch (e) {
        rejected = e.statusCode === 400;
      }
      assert(rejected, 'Already replaced QR must reject with HTTP 400');
    });

    // ------------------------------------------------------------------
    // SECTION 3: REVOCATION / SESSION-CREATION RACE ELIMINATION
    // ------------------------------------------------------------------
    console.log('\n--- SECTION 3: REVOCATION & SESSION RESOLUTION CONCURRENCY RACES ---');

    await test('3.1: Concurrent revocation & resolution coordination (5 consecutive race cycles)', async () => {
      for (let cycle = 1; cycle <= 5; cycle++) {
        // Clean up previous active on machineB
        await prisma.printerQr.updateMany({
          where: { machineId: machineB.id, status: 'ACTIVE' },
          data: { status: 'REVOKED', revokedReason: 'Cycle cleanup' }
        });

        // Create fresh active QR on machineB
        const qr = await printerQrService.generatePrinterQr(machineB.id, { label: `Race Cycle ${cycle}` }, superadminUser);
        testQrIds.push(qr.id);

        // Fire 1 revocation and 10 resolutions simultaneously
        const promises = [
          printerQrService.revokePrinterQr(qr.id, `Revocation triggered during concurrency cycle ${cycle}`, superadminUser)
        ];

        for (let i = 0; i < 10; i++) {
          promises.push(
            printerQrService.resolvePrinterQr(qr.publicCode)
              .then(res => {
                testSessionCodes.push(res.sessionCode);
                return { success: true, code: res.sessionCode };
              })
              .catch(err => ({ success: false, status: err.statusCode }))
          );
        }

        const outcomes = await Promise.all(promises);
        const revokeResult = outcomes[0];
        const resolveResults = outcomes.slice(1);

        assert(revokeResult.status === 'REVOKED', `Cycle ${cycle}: Revocation must complete with status REVOKED`);

        // Post-revocation resolution check: MUST ALWAYS FAIL WITH 410
        let postRevokeFailedClosed = false;
        try {
          await printerQrService.resolvePrinterQr(qr.publicCode);
        } catch (e) {
          postRevokeFailedClosed = e.statusCode === 410;
        }
        assert(postRevokeFailedClosed, `Cycle ${cycle}: Post-revocation resolution MUST fail with HTTP 410 Gone`);

        // Verify that any sessions created during the race were created BEFORE revocation committed
        const sessionsInDb = await prisma.session.findMany({
          where: { printerQrId: qr.id }
        });
        const qrInDb = await prisma.printerQr.findUnique({ where: { id: qr.id } });

        for (const s of sessionsInDb) {
          assert(
            s.createdAt <= qrInDb.revokedAt,
            `Cycle ${cycle}: Session ${s.code} createdAt (${s.createdAt.toISOString()}) must be <= revokedAt (${qrInDb.revokedAt.toISOString()})`
          );
        }
      }
    });

    // ------------------------------------------------------------------
    // SECTION 4: ORPHANED QR DEFENSIVE HANDLING
    // ------------------------------------------------------------------
    console.log('\n--- SECTION 4: ORPHANED QR DEFENSIVE HANDLING ---');

    const orphanedQr = await prisma.printerQr.create({
      data: {
        publicCode: printerQrService.generateSecurePublicCode(),
        label: 'Orphaned QR For Defensive Tests',
        status: 'ACTIVE',
        machineId: null,
        generatedBy: 'TEST'
      }
    });
    testQrIds.push(orphanedQr.id);

    await test('4.1: Customer session creation fails closed (HTTP 400) on orphaned QR (machineId = null)', async () => {
      let blocked = false;
      let statusCode = null;
      try {
        await printerQrService.resolvePrinterQr(orphanedQr.publicCode);
      } catch (e) {
        blocked = true;
        statusCode = e.statusCode;
      }
      assert(blocked && statusCode === 400, `Expected HTTP 400, got ${statusCode}`);
    });

    await test('4.2: Public pre-scan metadata fails closed (HTTP 400) on orphaned QR', async () => {
      let blocked = false;
      let statusCode = null;
      try {
        await printerQrService.getPublicPrinterQrInfo(orphanedQr.publicCode);
      } catch (e) {
        blocked = true;
        statusCode = e.statusCode;
      }
      assert(blocked && statusCode === 400, `Expected HTTP 400, got ${statusCode}`);
    });

    await test('4.3: Franchisee access to orphaned QR via getPrinterQrById fails closed (HTTP 403)', async () => {
      let blocked = false;
      let statusCode = null;
      try {
        await printerQrService.getPrinterQrById(orphanedQr.id, franchiseeA);
      } catch (e) {
        blocked = true;
        statusCode = e.statusCode;
      }
      assert(blocked && statusCode === 403, `Expected HTTP 403 for franchisee on orphaned QR, got ${statusCode}`);
    });

    await test('4.4: Franchisee access to orphaned QR via revokePrinterQr fails closed (HTTP 403)', async () => {
      let blocked = false;
      let statusCode = null;
      try {
        await printerQrService.revokePrinterQr(orphanedQr.id, 'Unauthorized revocation attempt of orphan', franchiseeA);
      } catch (e) {
        blocked = true;
        statusCode = e.statusCode;
      }
      assert(blocked && statusCode === 403, `Expected HTTP 403 for franchisee revoking orphan, got ${statusCode}`);
    });

    await test('4.5: Franchisee access to orphaned QR via replacePrinterQr fails closed (HTTP 403)', async () => {
      let blocked = false;
      let statusCode = null;
      try {
        await printerQrService.replacePrinterQr(orphanedQr.id, { reason: 'Unauthorized replacement of orphan' }, franchiseeA);
      } catch (e) {
        blocked = true;
        statusCode = e.statusCode;
      }
      assert(blocked && statusCode === 403, `Expected HTTP 403 for franchisee replacing orphan, got ${statusCode}`);
    });

    await test('4.6: Inactive/Maintenance machine fails closed for customer resolution (HTTP 403)', async () => {
      await prisma.machine.update({
        where: { id: machineA.id },
        data: { status: 'MAINTENANCE' }
      });

      let blocked = false;
      let statusCode = null;
      try {
        await printerQrService.resolvePrinterQr(currentActiveQr.publicCode);
      } catch (e) {
        blocked = true;
        statusCode = e.statusCode;
      }

      // Restore status
      await prisma.machine.update({
        where: { id: machineA.id },
        data: { status: 'ACTIVE' }
      });

      assert(blocked && statusCode === 403, `Expected HTTP 403 for maintenance machine, got ${statusCode}`);
    });

  } finally {
    console.log('\n--- CLEANING UP TEST FIXTURES ON DISPOSABLE TARGET ---');
    if (testSessionCodes.length > 0) {
      await prisma.session.deleteMany({
        where: { code: { in: testSessionCodes } }
      });
    }
    if (testQrIds.length > 0) {
      await prisma.session.deleteMany({
        where: { printerQrId: { in: testQrIds } }
      });
      await prisma.printerQr.deleteMany({
        where: { id: { in: testQrIds } }
      });
    }
    await prisma.machine.deleteMany({
      where: { machineKey: { in: ['p21_mch_key_a', 'p21_mch_key_b'] } }
    });
    await prisma.company.deleteMany({
      where: { contactEmail: { in: ['p21_shop_a@test.com', 'p21_shop_b@test.com'] } }
    });
    console.log('Cleanup completed successfully.\n');
  }

  await prisma.$disconnect();

  console.log('======================================================================');
  console.log(`PHASE 2.1 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('======================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Unhandled error in Phase 2.1 test suite:', err);
  process.exit(1);
});
