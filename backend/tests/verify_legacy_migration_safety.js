/**
 * Legacy Data Migration Safety Verification
 * Tests migration 20261118000011 against pre-existing legacy data using psql.exe.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PSQL = '"C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe" -U postgres -p 5433 -h 127.0.0.1 -d printgo_disposable_target';

function runSql(sql) {
  const tmpFile = path.join(process.env.TEMP || 'C:\\Windows\\Temp', `tmp_mig_${Date.now()}_${Math.random().toString(36).substring(7)}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf8');
  try {
    const output = execSync(`${PSQL} -f "${tmpFile}"`, { encoding: 'utf8' });
    return output;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function queryJson(sql) {
  const wrappedSql = `SELECT json_agg(t) FROM (${sql}) t;`;
  const tmpFile = path.join(process.env.TEMP || 'C:\\Windows\\Temp', `tmp_query_${Date.now()}_${Math.random().toString(36).substring(7)}.sql`);
  fs.writeFileSync(tmpFile, wrappedSql, 'utf8');
  try {
    const raw = execSync(`${PSQL} -t -A -f "${tmpFile}"`, { encoding: 'utf8' }).trim();
    if (!raw || raw === '') return [];
    return JSON.parse(raw);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function runLegacyMigrationSafetyCheck() {
  console.log('--- Step A: Drop all tables to start from clean database ---');
  runSql(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);

  console.log('--- Step B: Apply migrations 0000 through 0010 (Pre-Migration State) ---');
  const migrationsDir = path.resolve(__dirname, '../prisma/migrations');
  const migrationDirs = fs.readdirSync(migrationsDir)
    .filter(d => fs.statSync(path.join(migrationsDir, d)).isDirectory())
    .sort();

  for (const dir of migrationDirs) {
    if (dir.includes('20261118000011')) break; // Stop before migration 11
    console.log(`  Applying pre-migration: ${dir}`);
    const filePath = path.join(migrationsDir, dir, 'migration.sql');
    const sql = fs.readFileSync(filePath, 'utf8');
    runSql(sql);
  }

  console.log('--- Step C: Seed Pre-Existing Legacy Data ---');
  runSql(`
    -- 1. Company & User
    INSERT INTO "Company" (id, name, "contactEmail", "createdAt", "updatedAt")
    VALUES ('comp_legacy_1', 'Legacy Xerox Shop', 'xerox@shop.local', NOW(), NOW());

    INSERT INTO "User" (id, email, password, name, role, "companyId", "createdAt", "updatedAt")
    VALUES ('user_legacy_1', 'owner@xerox.local', 'hashed_pw', 'Legacy Owner', 'FRANCHISEE', 'comp_legacy_1', NOW(), NOW());

    -- 2. Legacy Machines (Created before paymentMode existed)
    INSERT INTO "Machine" (id, "machineKey", name, location, "companyId", status, "connectionType", "createdAt", "updatedAt")
    VALUES
      ('mach_legacy_1', 'key_legacy_1', 'HP LaserJet Counter', 'Main Counter', 'comp_legacy_1', 'ACTIVE', 'USB', NOW(), NOW()),
      ('mach_pilot_1', 'key_pilot_1', 'Epson L6460 Pilot', 'Pilot Counter', 'comp_legacy_1', 'ACTIVE', 'USB', NOW(), NOW());

    -- 3. Legacy Session (Created before paymentMode existed)
    INSERT INTO "Session" (id, code, "machineId", status, "expiresAt", "createdAt", "updatedAt")
    VALUES ('sess_legacy_1', 'sess_old_code_1', 'mach_legacy_1', 'COMPLETED', NOW() + interval '1 hour', NOW(), NOW());

    -- 4. Document
    INSERT INTO "Document" (id, filename, "originalName", mimetype, size, pages, "createdAt", "updatedAt")
    VALUES ('doc_legacy_1', 'test.pdf', 'test.pdf', 'application/pdf', 1024, 2, NOW(), NOW());

    -- 5. Historical Payments
    INSERT INTO "Payment" (id, amount, currency, type, status, "paymentMethod", "paymentGroup", "gatewayOrderId", "paidAt", "createdAt", "updatedAt")
    VALUES
      ('pay_card_1', 20.0, 'INR', 'PRINT_JOB', 'SUCCESS', 'card', 'card', 'order_cf_legacy_1', NOW(), NOW(), NOW()),
      ('pay_demo_1', 10.0, 'INR', 'PRINT_JOB', 'SUCCESS', 'demo', 'simulated', 'demo_order_legacy_1', NOW(), NOW(), NOW()),
      ('pay_cash_1', 15.0, 'INR', 'PRINT_JOB', 'SUCCESS', 'cash', 'cash', 'cash_order_legacy_1', NOW(), NOW(), NOW());

    -- 6. Historical PrintJobs
    INSERT INTO "PrintJob" (id, "shortId", "machineId", "documentId", cost, color, duplex, copies, "pagesToPrint", "pageRangeType", status, "paymentId", "createdAt", "updatedAt")
    VALUES
      ('job_card_1', 'card1234', 'mach_legacy_1', 'doc_legacy_1', 20.0, 'bw', 'single', 1, 2, 'all', 'COMPLETED', 'pay_card_1', NOW(), NOW()),
      ('job_demo_1', 'demo1234', 'mach_legacy_1', 'doc_legacy_1', 10.0, 'bw', 'single', 1, 2, 'all', 'COMPLETED', 'pay_demo_1', NOW(), NOW()),
      ('job_cash_1', 'cash1234', 'mach_legacy_1', 'doc_legacy_1', 15.0, 'bw', 'single', 1, 2, 'all', 'COMPLETED', 'pay_cash_1', NOW(), NOW()),
      ('job_unpaid_1', 'unpd1234', 'mach_legacy_1', 'doc_legacy_1', 8.0, 'bw', 'single', 1, 2, 'all', 'PENDING_PAYMENT', NULL, NOW(), NOW());
  `);

  console.log('--- Step D: Applying Migration 20261118000011 ---');
  const migration11Path = path.join(migrationsDir, '20261118000011_add_cash_payment_mode_and_confirmation/migration.sql');
  const migration11Sql = fs.readFileSync(migration11Path, 'utf8');
  runSql(migration11Sql);

  console.log('--- Step E: Verifying Migration Integrity Assertions ---');

  // Assertion 1: Legacy Machine retains NULL paymentMode (NOT converted to CASH_AT_COUNTER!)
  const machRows = queryJson(`SELECT id, "paymentMode" FROM "Machine" WHERE id = 'mach_legacy_1'`);
  if (machRows[0].paymentMode !== null) {
    throw new Error(`FAIL: mach_legacy_1 paymentMode is '${machRows[0].paymentMode}', must be NULL!`);
  }
  console.log('✅ PASS: Legacy Machine paymentMode is NULL (did not silently force cash)');

  // Assertion 2: Legacy Session retains NULL paymentMode
  const sessRows = queryJson(`SELECT id, "paymentMode" FROM "Session" WHERE id = 'sess_legacy_1'`);
  if (sessRows[0].paymentMode !== null) {
    throw new Error(`FAIL: sess_legacy_1 paymentMode is '${sessRows[0].paymentMode}', must be NULL!`);
  }
  console.log('✅ PASS: Legacy Session paymentMode is NULL (did not fabricate payment mode)');

  // Assertion 3: Unpaid / Undetermined historical PrintJob retains NULL paymentMode
  const unpaidRows = queryJson(`SELECT "shortId", "paymentMode" FROM "PrintJob" WHERE "shortId" = 'unpd1234'`);
  if (unpaidRows[0].paymentMode !== null) {
    throw new Error(`FAIL: unpaid job paymentMode is '${unpaidRows[0].paymentMode}', must be NULL!`);
  }
  console.log('✅ PASS: Historical unpaid PrintJob paymentMode is NULL (not mislabeled as cash)');

  // Assertion 4: Historical card job backfilled to CASHFREE_ONLINE
  const cardRows = queryJson(`SELECT "shortId", "paymentMode" FROM "PrintJob" WHERE "shortId" = 'card1234'`);
  if (cardRows[0].paymentMode !== 'CASHFREE_ONLINE') {
    throw new Error(`FAIL: card job paymentMode is '${cardRows[0].paymentMode}', must be 'CASHFREE_ONLINE'!`);
  }
  console.log('✅ PASS: Historical card PrintJob reliably backfilled to CASHFREE_ONLINE');

  // Assertion 5: Historical demo job backfilled to DEMO_SIMULATION
  const demoRows = queryJson(`SELECT "shortId", "paymentMode" FROM "PrintJob" WHERE "shortId" = 'demo1234'`);
  if (demoRows[0].paymentMode !== 'DEMO_SIMULATION') {
    throw new Error(`FAIL: demo job paymentMode is '${demoRows[0].paymentMode}', must be 'DEMO_SIMULATION'!`);
  }
  console.log('✅ PASS: Historical demo PrintJob reliably backfilled to DEMO_SIMULATION');

  // Assertion 6: Historical cash job backfilled to CASH_AT_COUNTER
  const cashRows = queryJson(`SELECT "shortId", "paymentMode" FROM "PrintJob" WHERE "shortId" = 'cash1234'`);
  if (cashRows[0].paymentMode !== 'CASH_AT_COUNTER') {
    throw new Error(`FAIL: cash job paymentMode is '${cashRows[0].paymentMode}', must be 'CASH_AT_COUNTER'!`);
  }
  console.log('✅ PASS: Historical cash PrintJob reliably backfilled to CASH_AT_COUNTER');

  // Assertion 7: Explicitly configure CASH_AT_COUNTER for the intended client machine ONLY
  console.log('--- Step F: Explicitly configuring client pilot machine for CASH_AT_COUNTER ---');
  runSql(`UPDATE "Machine" SET "paymentMode" = 'CASH_AT_COUNTER' WHERE id = 'mach_pilot_1';`);

  const pilotRows = queryJson(`SELECT id, "paymentMode" FROM "Machine" WHERE id = 'mach_pilot_1'`);
  const otherRows = queryJson(`SELECT id, "paymentMode" FROM "Machine" WHERE id = 'mach_legacy_1'`);

  if (pilotRows[0].paymentMode !== 'CASH_AT_COUNTER') {
    throw new Error('FAIL: mach_pilot_1 was not updated to CASH_AT_COUNTER');
  }
  if (otherRows[0].paymentMode !== null) {
    throw new Error('FAIL: mach_legacy_1 was inadvertently altered!');
  }
  console.log('✅ PASS: Client machine alone configured for CASH_AT_COUNTER while other machines remain untouched');

  // Assertion 8: New sessions and jobs receive intended mode explicitly
  console.log('--- Step G: Testing explicit assignment for new sessions & jobs ---');
  runSql(`
    INSERT INTO "Session" (id, code, "machineId", status, "paymentMode", "expiresAt", "createdAt", "updatedAt")
    VALUES ('sess_new_1', 'sess_new_code_1', 'mach_pilot_1', 'WAITING_FOR_MOBILE', 'CASH_AT_COUNTER', NOW() + interval '1 hour', NOW(), NOW());

    INSERT INTO "PrintJob" (id, "shortId", "machineId", "documentId", cost, color, duplex, copies, "pagesToPrint", "pageRangeType", status, "paymentMode", "createdAt", "updatedAt")
    VALUES ('job_new_1', 'newc1234', 'mach_pilot_1', 'doc_legacy_1', 4.0, 'bw', 'single', 1, 2, 'all', 'PENDING_PAYMENT', 'CASH_AT_COUNTER', NOW(), NOW());
  `);

  const newSess = queryJson(`SELECT "paymentMode" FROM "Session" WHERE id = 'sess_new_1'`);
  const newJob = queryJson(`SELECT "paymentMode" FROM "PrintJob" WHERE id = 'job_new_1'`);

  if (newSess[0].paymentMode !== 'CASH_AT_COUNTER' || newJob[0].paymentMode !== 'CASH_AT_COUNTER') {
    throw new Error('FAIL: New session or job did not receive explicit CASH_AT_COUNTER paymentMode');
  }
  console.log('✅ PASS: New sessions and jobs explicitly snapshot CASH_AT_COUNTER');

  console.log('\n======================================================================');
  console.log('ALL LEGACY MIGRATION SAFETY ASSERTIONS PASSED (8/8)');
  console.log('======================================================================\n');
}

runLegacyMigrationSafetyCheck().catch(err => {
  console.error('❌ MIGRATION SAFETY CHECK FAILED:', err);
  process.exit(1);
});
