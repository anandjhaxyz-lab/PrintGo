/**
 * Automated Test Suite: S3K Phase 2B — Targeted Staging Remediation Verification
 *
 * Strictly offline / isolated (no live DB mutations, no Cashfree calls, no printing):
 * 1. Verifies render.staging.yaml blueprint fixes (preDeployCommand, healthCheckPath, 0.5c-512mb, 0.1c-256mb, isolation)
 * 2. Verifies Winston logger enables redacted Console transport in NODE_ENV=production while preserving File transports
 * 3. Verifies advertisements storage aligns with ADS_UPLOAD_DIR and preserves readOnlyGuard
 * 4. Verifies machines.controller.js getPublicKey uses shared Prisma client
 * 5. Verifies provisionStagingPilot.js hard-guards against printgo_db, dry-run, confirmation flag, and idempotency
 * 6. Verifies dual-origin CORS policy for Customer Portal + Render Admin Dashboard
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const request = require('supertest');

const repoRoot = path.resolve(__dirname, '../..');
const backendRoot = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name} -> ${err.message}`);
    failed++;
  }
}

async function runTests() {
  console.log('=== S3K Phase 2B Targeted Staging Remediation Tests ===');

  // 1. render.staging.yaml Blueprint Validation
  await runCase('1. render.staging.yaml moves prisma migrate deploy to preDeployCommand & sets healthCheckPath', () => {
    const yamlContent = fs.readFileSync(path.join(repoRoot, 'render.staging.yaml'), 'utf8');
    assert(yamlContent.includes('buildCommand: npm install && npx prisma generate'), 'buildCommand keeps prisma generate');
    assert(!/buildCommand:.*prisma migrate deploy/.test(yamlContent), 'buildCommand must not execute prisma migrate deploy');
    assert(yamlContent.includes('preDeployCommand: npx prisma migrate deploy'), 'preDeployCommand runs prisma migrate deploy');
    assert(yamlContent.includes('healthCheckPath: /api/health'), 'healthCheckPath set to /api/health');
    assert(yamlContent.includes('plan: 0.5c-512mb'), 'backend plan updated to 0.5c-512mb');
    assert(yamlContent.includes('plan: 0.1c-256mb'), 'Postgres plan updated to 0.1c-256mb');
    assert(yamlContent.includes('databaseName: printgo_staging'), 'staging database is printgo_staging');
    assert(yamlContent.includes('value: sandbox'), 'CASHFREE_ENV=sandbox preserved');
    assert(yamlContent.includes('value: "false"'), 'ENABLE_DEMO_PAYMENT="false" preserved');
    assert(yamlContent.includes('value: "true"'), 'ADMIN_READ_ONLY="true" preserved');
    assert(yamlContent.includes('customer portal') && yamlContent.includes('admin dashboard'), 'ALLOWED_ORIGINS comment clarifies both origins');
  });

  // 2. Winston Logger in NODE_ENV=production
  await runCase('2. Winston logger enables Console transport in production and redacts secrets', () => {
    const script = `
      process.env.NODE_ENV = 'production';
      const logger = require('./src/utils/logger');
      const transports = logger.transports.map(t => t.name);
      if (!transports.includes('console')) throw new Error('Missing console transport in production');
      if (!transports.includes('file')) throw new Error('Missing file transport in production');
      let captured = '';
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => { captured += String(chunk); return true; };
      logger.info('Auth header Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123def and cfsk_ma_test_secret999', {
        password: 'MySecretPassword',
        machineKey: 'mk_super_secret_key',
        db: 'postgresql://postgres:TopSecretPass@localhost:5433/printgo_staging'
      });
      process.stdout.write = origWrite;
      if (captured.includes('MySecretPassword')) throw new Error('Password leaked in log output');
      if (captured.includes('mk_super_secret_key')) throw new Error('machineKey leaked in log output');
      if (captured.includes('TopSecretPass')) throw new Error('DB password leaked in log output');
      if (captured.includes('abc123def')) throw new Error('JWT token leaked in log output');
      if (captured.includes('secret999')) throw new Error('Cashfree secret leaked in log output');
      if (!captured.includes('***REDACTED***')) throw new Error('Redaction marker missing');
      console.log('LOGGER_OK');
    `;
    const res = spawnSync(process.execPath, ['-e', script], {
      cwd: backendRoot,
      encoding: 'utf8'
    });
    assert.strictEqual(res.status, 0, `Logger subprocess failed: ${res.stderr || res.stdout}`);
    assert(res.stdout.includes('LOGGER_OK'), 'Logger subprocess did not confirm LOGGER_OK');
  });

  // 3. Advertisements upload storage alignment with persistent ADS_UPLOAD_DIR
  await runCase('3. Advertisements upload storage uses persistent ADS_UPLOAD_DIR and preserves readOnlyGuard', async () => {
    const prevAdsUploads = process.env.ADS_UPLOAD_DIR;
    const prevUploads = process.env.UPLOADS_DIR;
    const prevReadOnly = process.env.ADMIN_READ_ONLY;
    const prevJwt = process.env.JWT_SECRET;
    try {
      process.env.ADS_UPLOAD_DIR = '/var/data/ads';
      process.env.UPLOADS_DIR = '/var/data/uploads';
      process.env.ADMIN_READ_ONLY = 'true';
      process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase2b_test_secret';

      const { getAdsUploadsDir } = require('../src/utils/storage');
      const expected = path.resolve('/var/data/ads');
      assert.strictEqual(getAdsUploadsDir(), expected, `Expected ${expected}, got ${getAdsUploadsDir()}`);

      const routesSrc = fs.readFileSync(path.join(backendRoot, 'src/modules/advertisements/advertisements.routes.js'), 'utf8');
      assert(!routesSrc.includes("../../../uploads/ads"), 'advertisements.routes.js must not hardcode ../../../uploads/ads');
      assert(routesSrc.includes('getAdsUploadsDir'), 'advertisements.routes.js must use getAdsUploadsDir()');

      const controllerSrc = fs.readFileSync(path.join(backendRoot, 'src/modules/advertisements/advertisements.controller.js'), 'utf8');
      assert(!controllerSrc.includes("../../../uploads/ads"), 'advertisements.controller.js must not hardcode ../../../uploads/ads');

      const adRoutes = require('../src/modules/advertisements/advertisements.routes');
      const app = express();
      app.use('/api/advertisements', adRoutes);
      const res = await request(app).post('/api/advertisements/admin');
      assert.strictEqual(res.status, 401, 'Unauthenticated admin ad upload rejected with 401');
    } finally {
      if (prevAdsUploads === undefined) delete process.env.ADS_UPLOAD_DIR;
      else process.env.ADS_UPLOAD_DIR = prevAdsUploads;
      if (prevUploads === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = prevUploads;
      if (prevReadOnly === undefined) delete process.env.ADMIN_READ_ONLY;
      else process.env.ADMIN_READ_ONLY = prevReadOnly;
      if (prevJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prevJwt;
    }
  });

  // 4. Shared Prisma client in machines.controller.js
  await runCase('4. machines.controller.js getPublicKey uses shared Prisma client without per-request instantiation', async () => {
    const controllerSrc = fs.readFileSync(path.join(backendRoot, 'src/modules/machines/machines.controller.js'), 'utf8');
    assert(!controllerSrc.includes('new PrismaClient()'), 'Must not instantiate new PrismaClient() per request');
    assert(controllerSrc.includes("require('../../utils/prisma')"), 'Must import shared utils/prisma');

    const prisma = require('../src/utils/prisma');
    const origFindUnique = prisma.machine.findUnique;
    prisma.machine.findUnique = async ({ where }) => (
      where.id === 'm_ok' ? { publicKey: 'MOCK_PEM_KEY' } : null
    );
    try {
      const machinesController = require('../src/modules/machines/machines.controller');
      const app = express();
      app.get('/api/machines/:id/public-key', machinesController.getPublicKey);

      const okRes = await request(app).get('/api/machines/m_ok/public-key');
      assert.strictEqual(okRes.status, 200);
      assert.strictEqual(okRes.body.publicKey, 'MOCK_PEM_KEY');

      const missRes = await request(app).get('/api/machines/m_missing/public-key');
      assert.strictEqual(missRes.status, 404);
    } finally {
      prisma.machine.findUnique = origFindUnique;
    }
  });

  // 5. provisionStagingPilot.js safety guards & idempotency
  await runCase('5. provisionStagingPilot.js refuses printgo_db, enforces confirmation, supports dry-run & idempotency', async () => {
    const provisioner = require('../scripts/provisionStagingPilot');

    // Reject production DB URL
    assert.throws(() => {
      provisioner.validateProvisioningSafety({
        databaseUrl: 'postgresql://user:pass@localhost:5432/printgo_db?schema=public',
        machineKey: 'staging_key_123',
        argv: ['--dry-run']
      });
    }, /Refusing to run against database 'printgo_db'/);

    // Reject disposable DB URL
    assert.throws(() => {
      provisioner.validateProvisioningSafety({
        databaseUrl: 'postgresql://user:pass@localhost:5433/printgo_disposable_target?schema=public',
        machineKey: 'staging_key_123',
        argv: ['--dry-run']
      });
    }, /Refusing to run against database 'printgo_disposable_target'/);

    // Reject --apply without explicit confirmation flag
    assert.throws(() => {
      provisioner.validateProvisioningSafety({
        databaseUrl: 'postgresql://user:pass@dpg-x/printgo_staging',
        machineKey: 'staging_key_123',
        argv: ['--apply']
      });
    }, /--confirm-staging-db=printgo_staging/);

    // Mock live DB identity mismatch guard
    await assert.rejects(async () => {
      await provisioner.assertLiveDatabaseIdentity({
        $queryRawUnsafe: async () => [{ db_name: 'printgo_db' }]
      });
    }, /Connected live database identity is 'printgo_db'/);

    // In-memory store to test dry-run + apply + idempotent rerun
    const store = { machine: null, qr: null, pricing: null, business: null };
    let writes = 0;
    const makeTx = () => ({
      machine: {
        findUnique: async () => store.machine,
        create: async ({ data }) => { writes++; store.machine = { id: 'mach_1', ...data }; return store.machine; }
      },
      printerQr: {
        findFirst: async () => (store.qr?.status === 'ACTIVE' ? store.qr : null),
        create: async ({ data }) => { writes++; store.qr = { id: 'qr_1', ...data }; return store.qr; }
      },
      printPricingProfile: {
        findUnique: async () => store.pricing,
        create: async ({ data }) => { writes++; store.pricing = { id: 'price_1', ...data }; return store.pricing; }
      },
      businessProfile: {
        findFirst: async () => store.business,
        create: async ({ data }) => { writes++; store.business = { id: 'biz_1', ...data }; return store.business; }
      }
    });

    const mockPrisma = {
      ...makeTx(),
      $queryRawUnsafe: async () => [{ db_name: 'printgo_staging' }],
      $transaction: async (fn) => fn(makeTx())
    };

    const drySummary = await provisioner.provisionStagingPilot({
      prismaClient: mockPrisma,
      databaseUrl: 'postgresql://u:p@dpg-x/printgo_staging',
      machineKey: 'staging_only_test_key',
      argv: ['--dry-run'],
      logger: { log: () => {} }
    });
    assert.strictEqual(drySummary.mode, 'DRY_RUN');
    assert.strictEqual(writes, 0, 'Dry-run must perform 0 DB writes');
    assert.strictEqual(drySummary.printerQr.action, 'WOULD_CREATE');

    const apply1 = await provisioner.provisionStagingPilot({
      prismaClient: mockPrisma,
      databaseUrl: 'postgresql://u:p@dpg-x/printgo_staging',
      machineKey: 'staging_only_test_key',
      argv: ['--apply', '--confirm-staging-db=printgo_staging'],
      logger: { log: () => {} }
    });
    assert.strictEqual(apply1.mode, 'APPLY');
    assert.strictEqual(apply1.printerQr.action, 'CREATED');
    assert(apply1.printerQr.publicCode.startsWith('pq_'), 'Generated publicCode uses pq_ prefix');
    const firstCode = apply1.printerQr.publicCode;
    assert.strictEqual(writes, 4);

    // Rerun must be strictly idempotent and preserve QR identity
    const apply2 = await provisioner.provisionStagingPilot({
      prismaClient: mockPrisma,
      databaseUrl: 'postgresql://u:p@dpg-x/printgo_staging',
      machineKey: 'staging_only_test_key',
      argv: ['--apply', '--confirm-staging-db=printgo_staging'],
      logger: { log: () => {} }
    });
    assert.strictEqual(apply2.machine.action, 'REUSED');
    assert.strictEqual(apply2.printerQr.action, 'PRESERVED');
    assert.strictEqual(apply2.printerQr.publicCode, firstCode, 'Rerun must preserve permanent publicCode');
    assert.strictEqual(writes, 4, 'Rerun must perform 0 additional writes');
  });

  // 6. Dual-Origin CORS Policy (Customer + Render Admin)
  await runCase('6. Dual-origin ALLOWED_ORIGINS supports both Customer Portal & Render Admin in production', () => {
    const { createCorsOriginValidator } = require('../src/server');
    const customerOrigin = 'https://staging-customer.example.com';
    const adminOrigin = 'https://printgo-admin-staging.onrender.com';

    const { allowedOriginsSet, corsOriginValidator } = createCorsOriginValidator({
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: `${customerOrigin}/, ${adminOrigin}/`,
      FRONTEND_URL: customerOrigin,
      PUBLIC_APP_URL: customerOrigin
    });

    assert(allowedOriginsSet.has(customerOrigin), 'Customer HTTPS origin normalized without trailing slash');
    assert(allowedOriginsSet.has(adminOrigin), 'Admin HTTPS origin normalized without trailing slash');
    assert(!allowedOriginsSet.has('http://localhost:5173'), 'Localhost excluded in production');

    corsOriginValidator(adminOrigin, (err, ok) => {
      assert(!err && ok === true, 'Admin origin must pass CORS');
    });
    corsOriginValidator(customerOrigin, (err, ok) => {
      assert(!err && ok === true, 'Customer origin must pass CORS');
    });
    corsOriginValidator('https://unauthorized-site.example.com', (err, ok) => {
      assert(err && ok === false, 'Unauthorized origin must fail CORS');
    });
  });

  console.log(`\nPhase 2B Remediation Verification Summary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Fatal test failure:', err);
  process.exit(1);
});
