jest.mock('../../src/services/pricing.service', () => ({
  getPricingProfile: jest.fn(async () => ({})),
  serializePublicPricingProfile: jest.fn(() => ({ currency: 'INR' }))
}));
jest.mock('../../src/config/cashfree.config', () => ({ resolveCashfreeEnv: jest.fn(() => ({ env: 'sandbox' })) }));
jest.mock('../../src/utils/demoPaymentGuard', () => ({ isDemoPaymentPermitted: jest.fn(() => false), isDemoAccessCodeRequired: jest.fn(() => false) }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/printerAvailability.service', () => ({
  getMachineAvailability: jest.fn(async () => ({ isReady: true, status: 'ONLINE', statusMessage: 'Ready' })),
  getPrinterDeviceAvailability: jest.fn(async (_machineId, printerDeviceId) => ({ printerDeviceId, isReady: true, status: 'ONLINE', statusMessage: 'Ready', agentOnline: true, paperStatus: 'OK', tonerStatus: 'OK', jamStatus: false, name: 'Test Shop', location: 'Test', printerModel: 'Test Printer' }))
}));

const prisma = require('../../src/utils/prisma');
const { approveLegacyQrBinding, revokeLegacyQrBinding } = require('../../src/services/legacyPrinterQrBinding.service');
const { resolvePrinterQr } = require('../../src/services/printerQr.service');

function assertDisposableDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for this integration test.');
  const parsed = new URL(raw);
  const databaseName = parsed.pathname.replace(/^\//, '').split('?')[0];
  const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
  const expectedPort = isGitHubActions ? '5432' : '55432';
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || databaseName !== 'printgo_disposable_target' || parsed.port !== expectedPort) {
    throw new Error(`Safety stop: legacy QR concurrency tests require a local printgo_disposable_target database on port ${expectedPort} for this environment.`);
  }
}

const companyId = 'co_legacy_qr_concurrency';
const machineId = 'm_legacy_qr_concurrency';
const qrId = 'q_legacy_qr_concurrency';
const deviceAId = 'd_legacy_qr_concurrency_a';
const deviceBId = 'd_legacy_qr_concurrency_b';
const publicCode = 'fixture-legacy-qr-concurrency-only';
const admin = { id: 'superadmin_legacy_qr_concurrency', role: 'SUPERADMIN' };
const reason = 'Approved controlled integration test binding';

const waitFor = async (predicate, timeoutMs = 5000) => {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for PostgreSQL concurrency barrier.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const holdQrLock = async (callback) => {
  let release;
  let acquired;
  const lockAcquired = new Promise((resolve) => { acquired = resolve; });
  const lockRelease = new Promise((resolve) => { release = resolve; });
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM "PrinterQr" WHERE id = $1 FOR UPDATE', qrId);
    acquired();
    await lockRelease;
  }, { maxWait: 10000, timeout: 15000 });
  await lockAcquired;
  try {
    return await callback(release);
  } finally {
    release();
    await holder;
  }
};

describe('Legacy printer QR binding PostgreSQL concurrency integration', () => {
  const previousFlag = process.env.ENABLE_MULTI_PRINTER_DISPATCH;
  const previousSecret = process.env.JWT_SECRET;

  beforeAll(async () => {
    assertDisposableDatabaseUrl();
    process.env.ENABLE_MULTI_PRINTER_DISPATCH = 'true';
    process.env.JWT_SECRET = 'isolated-disposable-test-secret';
    await prisma.company.create({ data: { id: companyId, name: 'Legacy QR Concurrency Test', contactEmail: 'legacy-qr-concurrency@test.invalid' } });
    await prisma.machine.create({ data: { id: machineId, machineKey: 'disposable-legacy-qr-machine-key', name: 'Disposable QR Machine', status: 'ACTIVE', paymentMode: 'DEMO_SIMULATION', companyId } });
    await prisma.printerDevice.createMany({ data: [
      { id: deviceAId, machineId, displayName: 'Test Printer A', windowsPrinterName: 'TEST_QUEUE_A', status: 'ACTIVE', approvedAt: new Date(), approvedBy: admin.id },
      { id: deviceBId, machineId, displayName: 'Test Printer B', windowsPrinterName: 'TEST_QUEUE_B', status: 'ACTIVE', approvedAt: new Date(), approvedBy: admin.id }
    ] });
  });

  beforeEach(async () => {
    await prisma.session.deleteMany({ where: { printerQrId: qrId } });
    await prisma.legacyPrinterQrBinding.deleteMany({ where: { printerQrId: qrId } });
    await prisma.printerQr.deleteMany({ where: { id: qrId } });
    await prisma.printerQr.create({ data: { id: qrId, publicCode, machineId, status: 'ACTIVE' } });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { printerQrId: qrId } }).catch(() => {});
    await prisma.legacyPrinterQrBinding.deleteMany({ where: { printerQrId: qrId } }).catch(() => {});
    await prisma.printerQr.deleteMany({ where: { id: qrId } }).catch(() => {});
    await prisma.printerDevice.deleteMany({ where: { id: { in: [deviceAId, deviceBId] } } }).catch(() => {});
    await prisma.machine.deleteMany({ where: { id: machineId } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
    if (previousFlag === undefined) delete process.env.ENABLE_MULTI_PRINTER_DISPATCH; else process.env.ENABLE_MULTI_PRINTER_DISPATCH = previousFlag;
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
    await prisma.$disconnect();
  });

  test('serializes two simultaneous approvals for one QR: exactly one binding is created', async () => {
    const results = await Promise.allSettled([
      approveLegacyQrBinding({ prisma, qrId, printerDeviceId: deviceAId, reason, user: admin }),
      approveLegacyQrBinding({ prisma, qrId, printerDeviceId: deviceBId, reason, user: admin })
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const rows = await prisma.legacyPrinterQrBinding.findMany({ where: { printerQrId: qrId } });
    expect(rows).toHaveLength(1);
    expect([deviceAId, deviceBId]).toContain(rows[0].printerDeviceId);
    expect(rows[0].status).toBe('ACTIVE');
  });

  test('scan queued behind approval sees the committed alias and binds the new session to the approved device', async () => {
    await holdQrLock(async (release) => {
      const approval = approveLegacyQrBinding({ prisma, qrId, printerDeviceId: deviceAId, reason, user: admin });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const scan = resolvePrinterQr(publicCode);
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      const [approvalResult, scanResult] = await Promise.all([approval, scan]);
      expect(approvalResult).toMatchObject({ status: 'ACTIVE', printerDeviceId: deviceAId });
      expect(scanResult.success).toBe(true);
    });
    const sessions = await prisma.session.findMany({ where: { printerQrId: qrId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].printerDeviceId).toBe(deviceAId);
  });

  test('two simultaneous revocations serialize and retain one terminal tombstone', async () => {
    await prisma.legacyPrinterQrBinding.create({ data: { id: 'b_legacy_qr_double_revoke', printerQrId: qrId, machineId, printerDeviceId: deviceAId, status: 'ACTIVE', reason, approvedAt: new Date(), approvedBy: admin.id } });
    const results = await Promise.all([
      revokeLegacyQrBinding({ prisma, qrId, reason: 'Operator confirmed legacy QR retirement', user: admin }),
      revokeLegacyQrBinding({ prisma, qrId, reason: 'Second operator confirmed QR retirement', user: admin })
    ]);
    expect(results.filter((item) => item.alreadyRevoked !== true)).toHaveLength(1);
    expect(results.filter((item) => item.alreadyRevoked === true)).toHaveLength(1);
    expect(await prisma.legacyPrinterQrBinding.count({ where: { printerQrId: qrId, status: 'REVOKED' } })).toBe(1);
  });
  test('scan queued before revocation commits one correctly device-bound session; every later scan fails closed', async () => {
    await prisma.legacyPrinterQrBinding.create({ data: { id: 'b_legacy_qr_scan_before_revoke', printerQrId: qrId, machineId, printerDeviceId: deviceAId, status: 'ACTIVE', reason, approvedAt: new Date(), approvedBy: admin.id } });
    await holdQrLock(async (release) => {
      const scan = resolvePrinterQr(publicCode);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const revoke = revokeLegacyQrBinding({ prisma, qrId, reason: 'Operator confirmed legacy QR retirement', user: admin });
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      const [scanResult, revokeResult] = await Promise.all([scan, revoke]);
      expect(scanResult.success).toBe(true);
      expect(revokeResult.status).toBe('REVOKED');
    });
    const sessions = await prisma.session.findMany({ where: { printerQrId: qrId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].printerDeviceId).toBe(deviceAId);
    await expect(resolvePrinterQr(publicCode)).rejects.toMatchObject({ statusCode: 410 });
    expect(await prisma.session.count({ where: { printerQrId: qrId } })).toBe(1);
  });

  test('revocation queued before scan wins the QR row lock and prevents session creation', async () => {
    await prisma.legacyPrinterQrBinding.create({ data: { id: 'b_legacy_qr_revoke_before_scan', printerQrId: qrId, machineId, printerDeviceId: deviceAId, status: 'ACTIVE', reason, approvedAt: new Date(), approvedBy: admin.id } });
    await holdQrLock(async (release) => {
      const revoke = revokeLegacyQrBinding({ prisma, qrId, reason: 'Operator confirmed legacy QR retirement', user: admin });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const scan = resolvePrinterQr(publicCode);
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      const revokeResult = await revoke;
      expect(revokeResult.status).toBe('REVOKED');
      await expect(scan).rejects.toMatchObject({ statusCode: 410 });
    });
    expect(await prisma.session.count({ where: { printerQrId: qrId } })).toBe(0);
    expect(await prisma.legacyPrinterQrBinding.findUnique({ where: { printerQrId: qrId } })).toMatchObject({ status: 'REVOKED' });
  });
});
