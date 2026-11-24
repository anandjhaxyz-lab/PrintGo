/**
 * S3K PrintGo — Safe, Idempotent One-Time Staging Pilot Provisioner
 *
 * Provisions for an isolated staging environment ONLY:
 *   1. One ACTIVE staging Machine (using process.env.MACHINE_KEY)
 *   2. One permanent ACTIVE PrinterQr bound to that Machine (pq_...)
 *   3. One PrintPricingProfile bound to that Machine (if missing)
 *   4. One BusinessProfile record (if missing)
 *
 * Designed so ADMIN_READ_ONLY="true" can remain enabled in staging without
 * blocking initial PrinterQr creation.
 *
 * SAFETY GUARDS:
 *   - Hard-fails if DATABASE_URL or live current_database() is NOT "printgo_staging"
 *   - Explicitly refuses production DB names ("printgo_db", "printgo", etc.)
 *   - Defaults to DRY-RUN unless BOTH "--apply" and "--confirm-staging-db=printgo_staging" are passed
 *   - Never embeds or prints MACHINE_KEY, passwords, or connection credentials
 *   - Preserves existing ACTIVE PrinterQr identity on reruns (zero duplicates)
 *
 * Usage:
 *   Dry-run validation (no DB writes):
 *     node scripts/provisionStagingPilot.js --dry-run
 *
 *   One-time execution inside Render Shell / staging environment:
 *     node scripts/provisionStagingPilot.js --apply --confirm-staging-db=printgo_staging
 */

require('dotenv').config();
const crypto = require('crypto');

const ALLOWED_STAGING_DB = 'printgo_staging';
const FORBIDDEN_DB_NAMES = new Set([
  'printgo_db',
  'printgo',
  'postgres',
  'printgo_disposable_target',
  'printgo_staging_db'
]);

const generateSecurePublicCode = () => {
  const rawBytes = crypto.randomBytes(32).toString('base64url');
  return `pq_${rawBytes}`;
};

const parseCliArgs = (argv = process.argv.slice(2)) => {
  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run') || !apply;
  const confirmArg = argv.find((a) => a.startsWith('--confirm-staging-db='));
  const confirmedDb = confirmArg ? confirmArg.split('=')[1] : '';

  return { apply, dryRun, confirmedDb };
};

const extractDatabaseNameFromUrl = (databaseUrl) => {
  if (!databaseUrl || typeof databaseUrl !== 'string') {
    throw new Error('DATABASE_URL environment variable is required.');
  }
  const parsed = new URL(databaseUrl);
  const dbName = decodeURIComponent(parsed.pathname || '').replace(/^\/+/, '').trim();
  if (!dbName) {
    throw new Error('DATABASE_URL does not specify a database name.');
  }
  return dbName;
};

const assertStagingDatabaseUrl = (databaseUrl) => {
  const dbName = extractDatabaseNameFromUrl(databaseUrl);
  if (FORBIDDEN_DB_NAMES.has(dbName) || dbName !== ALLOWED_STAGING_DB) {
    throw new Error(
      `SAFETY ABORT: Refusing to run against database '${dbName}'. Only '${ALLOWED_STAGING_DB}' is permitted.`
    );
  }
  return dbName;
};

const assertLiveDatabaseIdentity = async (prismaClient) => {
  const rows = await prismaClient.$queryRawUnsafe('SELECT current_database() AS db_name;');
  const currentDb = rows?.[0]?.db_name;
  if (!currentDb || FORBIDDEN_DB_NAMES.has(currentDb) || currentDb !== ALLOWED_STAGING_DB) {
    throw new Error(
      `SAFETY ABORT: Connected live database identity is '${currentDb || 'UNKNOWN'}'. Must be '${ALLOWED_STAGING_DB}'.`
    );
  }
  return currentDb;
};

const validateProvisioningSafety = ({
  databaseUrl = process.env.DATABASE_URL,
  machineKey = process.env.MACHINE_KEY,
  argv = process.argv.slice(2)
} = {}) => {
  const opts = parseCliArgs(argv);
  const urlDbName = assertStagingDatabaseUrl(databaseUrl);

  if (!machineKey || typeof machineKey !== 'string' || !machineKey.trim()) {
    throw new Error('MACHINE_KEY environment variable is required (never hardcode keys).');
  }

  if (opts.apply && opts.confirmedDb !== ALLOWED_STAGING_DB) {
    throw new Error(
      `SAFETY ABORT: --apply requires explicit confirmation flag '--confirm-staging-db=${ALLOWED_STAGING_DB}'.`
    );
  }

  return {
    ...opts,
    urlDbName,
    machineKey: machineKey.trim()
  };
};

const provisionStagingPilot = async ({
  prismaClient,
  databaseUrl = process.env.DATABASE_URL,
  machineKey = process.env.MACHINE_KEY,
  argv = process.argv.slice(2),
  logger = console
} = {}) => {
  const config = validateProvisioningSafety({ databaseUrl, machineKey, argv });
  const liveDb = await assertLiveDatabaseIdentity(prismaClient);

  const summary = {
    mode: config.dryRun ? 'DRY_RUN' : 'APPLY',
    database: liveDb,
    machine: null,
    printerQr: null,
    pricingProfile: null,
    businessProfile: null
  };

  if (config.dryRun) {
    const existingMachine = await prismaClient.machine.findUnique({
      where: { machineKey: config.machineKey },
      select: { id: true, name: true, location: true, status: true, printerModel: true }
    });

    const existingQr = existingMachine
      ? await prismaClient.printerQr.findFirst({
          where: { machineId: existingMachine.id, status: 'ACTIVE' },
          select: { id: true, publicCode: true, label: true, status: true }
        })
      : null;

    const existingPricing = existingMachine
      ? await prismaClient.printPricingProfile.findUnique({
          where: { machineId: existingMachine.id },
          select: { id: true, name: true, isDefault: true, isActive: true }
        })
      : null;

    const existingBusiness = await prismaClient.businessProfile.findFirst({
      select: { id: true, legalName: true, invoicePrefix: true, nextInvoiceNumber: true }
    });

    summary.machine = existingMachine
      ? { action: 'WOULD_REUSE', ...existingMachine }
      : { action: 'WOULD_CREATE', name: process.env.STAGING_MACHINE_NAME || 'S3K Staging Epson L6460', status: 'ACTIVE' };
    summary.printerQr = existingQr
      ? { action: 'WOULD_PRESERVE', ...existingQr }
      : { action: 'WOULD_CREATE', label: process.env.STAGING_QR_LABEL || 'Front Desk Counter', status: 'ACTIVE' };
    summary.pricingProfile = existingPricing
      ? { action: 'WOULD_PRESERVE', ...existingPricing }
      : { action: 'WOULD_CREATE', name: 'S3K Staging Standard Pricing', isDefault: true, isActive: true };
    summary.businessProfile = existingBusiness
      ? { action: 'WOULD_PRESERVE', ...existingBusiness }
      : { action: 'WOULD_CREATE', legalName: 'PrintGo Self-Service Kiosks (Staging)', invoicePrefix: 'INV-STG-' };

    logger.log(`[DRY-RUN] Verified staging DB '${liveDb}'. No database writes performed.`);
    return summary;
  }

  // Idempotent transactional provisioning (APPLY mode)
  const result = await prismaClient.$transaction(async (tx) => {
    // 1. Machine (reused by MACHINE_KEY if already seeded by autoSeed)
    let machine = await tx.machine.findUnique({
      where: { machineKey: config.machineKey },
      select: { id: true, name: true, location: true, status: true, printerModel: true }
    });

    let machineAction = 'REUSED';
    if (!machine) {
      machine = await tx.machine.create({
        data: {
          name: process.env.STAGING_MACHINE_NAME || 'S3K Staging Epson L6460',
          location: process.env.STAGING_MACHINE_LOCATION || 'Staging Front Desk',
          printerModel: 'EPSON L6460 Series',
          machineKey: config.machineKey,
          status: 'ACTIVE'
        },
        select: { id: true, name: true, location: true, status: true, printerModel: true }
      });
      machineAction = 'CREATED';
    }

    // 2. Permanent ACTIVE PrinterQr (at most one ACTIVE QR per machine)
    let printerQr = await tx.printerQr.findFirst({
      where: { machineId: machine.id, status: 'ACTIVE' },
      select: { id: true, publicCode: true, label: true, status: true, machineId: true }
    });

    let qrAction = 'PRESERVED';
    if (!printerQr) {
      printerQr = await tx.printerQr.create({
        data: {
          publicCode: generateSecurePublicCode(),
          label: process.env.STAGING_QR_LABEL || 'Front Desk Counter',
          status: 'ACTIVE',
          machineId: machine.id,
          generatedBy: 'STAGING_PROVISIONER'
        },
        select: { id: true, publicCode: true, label: true, status: true, machineId: true }
      });
      qrAction = 'CREATED';
    }

    // 3. Machine PrintPricingProfile (idempotent via unique machineId)
    let pricingProfile = await tx.printPricingProfile.findUnique({
      where: { machineId: machine.id },
      select: { id: true, name: true, isDefault: true, isActive: true }
    });

    let pricingAction = 'PRESERVED';
    if (!pricingProfile) {
      pricingProfile = await tx.printPricingProfile.create({
        data: {
          name: 'S3K Staging Standard Pricing',
          isDefault: true,
          machineId: machine.id,
          bwSingleRate: 2.0,
          bwDuplexRate: 3.0,
          colorSingleRate: 10.0,
          colorDuplexRate: 18.0,
          a4Multiplier: 1.0,
          a3Multiplier: 2.0,
          legalMultiplier: 1.2,
          glossySurcharge: 0.0,
          minOrderAmount: 1.0,
          convenienceFee: 0.0,
          gstEnabled: false,
          gstRatePercent: 18.0,
          isTaxInclusive: true,
          isActive: true
        },
        select: { id: true, name: true, isDefault: true, isActive: true }
      });
      pricingAction = 'CREATED';
    }

    // 4. BusinessProfile (one default profile if none exists)
    let businessProfile = await tx.businessProfile.findFirst({
      select: { id: true, legalName: true, invoicePrefix: true, nextInvoiceNumber: true }
    });

    let businessAction = 'PRESERVED';
    if (!businessProfile) {
      businessProfile = await tx.businessProfile.create({
        data: {
          legalName: 'PrintGo Self-Service Kiosks (Staging)',
          tradeName: 'PrintGo Staging',
          gstin: null,
          sacCode: '9989',
          supportEmail: 'support@printgo.local',
          supportPhone: '+91 9999999999',
          city: 'Hyderabad',
          state: 'Telangana',
          stateCode: '36',
          invoicePrefix: 'INV-STG-',
          nextInvoiceNumber: 1001
        },
        select: { id: true, legalName: true, invoicePrefix: true, nextInvoiceNumber: true }
      });
      businessAction = 'CREATED';
    }

    return {
      machine: { action: machineAction, ...machine },
      printerQr: { action: qrAction, ...printerQr },
      pricingProfile: { action: pricingAction, ...pricingProfile },
      businessProfile: { action: businessAction, ...businessProfile }
    };
  });

  Object.assign(summary, result);
  logger.log(
    `[APPLY] Staging provisioning complete on '${liveDb}'. QR scan path: /p/${summary.printerQr.publicCode}`
  );
  return summary;
};

if (require.main === module) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  provisionStagingPilot({ prismaClient: prisma })
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((err) => {
      console.error('Staging provisioning error:', err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = {
  ALLOWED_STAGING_DB,
  FORBIDDEN_DB_NAMES,
  parseCliArgs,
  extractDatabaseNameFromUrl,
  assertStagingDatabaseUrl,
  assertLiveDatabaseIdentity,
  validateProvisioningSafety,
  provisionStagingPilot
};
