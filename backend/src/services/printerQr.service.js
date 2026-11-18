const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { getPricingProfile, serializePublicPricingProfile } = require('./pricing.service');
const { resolveCashfreeEnv } = require('../config/cashfree.config');
const { isDemoPaymentPermitted, isDemoAccessCodeRequired } = require('../utils/demoPaymentGuard');
const { DEFAULT_PAYMENT_MODE } = require('../constants/paymentModes');
const { getMachineAvailability } = require('./printerAvailability.service');

/**
 * Validates that an IP or hostname is not private/loopback in production.
 */
const isPrivateOrLoopbackHost = (hostname) => {
  const normalized = (hostname || '').toLowerCase().trim();
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
    return true;
  }
  // RFC 1918 and loopback checks
  if (/^127\./.test(normalized)) return true;
  if (/^10\./.test(normalized)) return true;
  if (/^192\.168\./.test(normalized)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(normalized)) return true;
  if (normalized.endsWith('.local')) return true;
  return false;
};

/**
 * Builds the canonical public customer scan URL for a given public code.
 * Fails closed in production if public URL is missing, invalid, non-HTTPS, or private.
 */
const getPublicQrUrl = (publicCode) => {
  const configuredDomain = process.env.PUBLIC_APP_URL || process.env.PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL;
  const isProduction = process.env.NODE_ENV === 'production';

  if (!configuredDomain) {
    if (isProduction) {
      throw new AppError('Public QR URL configuration error: PUBLIC_APP_URL must be configured in production', 500);
    }
    return `http://localhost:5173/p/${publicCode}`;
  }

  // Parse candidate URL (take first if comma-separated)
  const candidate = configuredDomain.split(',')[0].trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AppError('Public QR URL configuration error: invalid URL format in PUBLIC_APP_URL', 500);
  }

  if (isProduction) {
    if (parsed.protocol !== 'https:') {
      throw new AppError('Public QR URL security error: Production QR URL must use HTTPS', 500);
    }
    if (isPrivateOrLoopbackHost(parsed.hostname)) {
      throw new AppError('Public QR URL security error: Private LAN or loopback addresses are forbidden in production QR codes', 500);
    }
  }

  return `${candidate}/p/${publicCode}`;
};

/**
 * Generates a cryptographically secure, high-entropy, URL-safe random public code.
 * 32 bytes = 256 bits of true randomness.
 */
const generateSecurePublicCode = () => {
  const rawBytes = crypto.randomBytes(32).toString('base64url');
  return `pq_${rawBytes}`;
};

/**
 * Verifies that a user has authorization over a machine.
 * Superadmin can access all; Franchisee/Staff can only access machines belonging to their company.
 */
const verifyMachineAccess = async (machineId, user) => {
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    include: { company: true }
  });

  if (!machine) {
    throw new AppError('Target printer not found', 404);
  }

  if (user && user.role !== 'SUPERADMIN') {
    if (!machine.companyId || machine.companyId !== user.companyId) {
      throw new AppError('Access denied: You do not have permission to manage this printer', 403);
    }
  }

  return machine;
};

/**
 * Generates a new permanent dedicated QR code for a printer.
 * Strict Invariant: A machine may have at most one ACTIVE PrinterQr record.
 * Rejects with HTTP 409 if an ACTIVE QR already exists.
 * Does not silently replace an existing QR; explicit rotation must use replacePrinterQr.
 */
const generatePrinterQr = async (machineId, data = {}, user = null) => {
  if (!machineId) {
    throw new AppError('machineId is required to generate a dedicated printer QR', 400);
  }

  const machine = await verifyMachineAccess(machineId, user);

  if (machine.status === 'SUSPENDED') {
    throw new AppError('Cannot generate a QR for a suspended printer', 400);
  }

  // Pre-check invariant: reject if an ACTIVE QR already exists for this machine
  const existingActive = await prisma.printerQr.findFirst({
    where: {
      machineId: machine.id,
      status: 'ACTIVE'
    }
  });

  if (existingActive) {
    throw new AppError('An active dedicated QR already exists for this printer. Use replace to rotate.', 409);
  }

  const label = (data.label || 'Front Desk Counter').trim();
  const operatorId = user ? (user.id || user.email) : 'SYSTEM';

  // Strictly bounded collision retry (max 3 attempts)
  let publicCode;
  let attempts = 0;
  let created = null;

  while (attempts < 3) {
    attempts++;
    publicCode = generateSecurePublicCode();
    try {
      created = await prisma.printerQr.create({
        data: {
          publicCode,
          label,
          status: 'ACTIVE',
          machineId: machine.id,
          generatedBy: operatorId
        },
        include: {
          machine: {
            select: { id: true, name: true, location: true, status: true, printerModel: true }
          }
        }
      });
      break;
    } catch (err) {
      // PostgreSQL partial unique index enforcement (printer_qrs_machine_id_active_unique)
      if (err.code === 'P2002') {
        const target = err.meta && (err.meta.target || JSON.stringify(err.meta));
        const targetStr = typeof target === 'string' ? target : JSON.stringify(target);
        if (targetStr.includes('machineId') || targetStr.includes('printer_qrs_machine_id_active_unique')) {
          throw new AppError('An active dedicated QR already exists for this printer. Use replace to rotate.', 409);
        }
        // If publicCode collided (astronomically rare), retry
        if (attempts < 3) {
          continue;
        }
      }
      throw err;
    }
  }

  if (!created) {
    throw new AppError('Failed to generate a unique public code after retries', 500);
  }

  logger.info(`Generated permanent QR [${created.publicCode}] for machine [${machine.id}] by [${operatorId}]`);

  return {
    ...created,
    targetUrl: getPublicQrUrl(created.publicCode)
  };
};

/**
 * Lists dedicated printer QR records with pagination, filtering, and role scoping.
 */
const listPrinterQrs = async (user, query = {}) => {
  const { page = 1, limit = 50, machineId, status, search } = query;
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

  const where = {};

  // Role scoping: non-superadmin users only see QRs for their company's machines
  if (user && user.role !== 'SUPERADMIN') {
    where.machine = { companyId: user.companyId };
  }

  if (machineId) {
    where.machineId = machineId;
  }

  if (status) {
    where.status = status;
  }

  if (search) {
    where.OR = [
      { publicCode: { contains: search, mode: 'insensitive' } },
      { label: { contains: search, mode: 'insensitive' } },
      { machine: { name: { contains: search, mode: 'insensitive' } } }
    ];
  }

  const [qrs, total] = await Promise.all([
    prisma.printerQr.findMany({
      where,
      skip,
      take: Number(limit),
      include: {
        machine: {
          select: { id: true, name: true, location: true, status: true, printerModel: true, companyId: true }
        },
        _count: {
          select: { sessions: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.printerQr.count({ where })
  ]);

  const qrsWithUrls = qrs.map(q => ({
    ...q,
    targetUrl: getPublicQrUrl(q.publicCode)
  }));

  return {
    qrs: qrsWithUrls,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit))
    }
  };
};

/**
 * Retrieves a single QR record by its internal UUID with machine details and audit metadata.
 * Defensive Check: Non-superadmin access is denied for orphaned or cross-tenant QRs.
 */
const getPrinterQrById = async (id, user = null) => {
  const qr = await prisma.printerQr.findUnique({
    where: { id },
    include: {
      machine: {
        select: { id: true, name: true, location: true, status: true, printerModel: true, companyId: true }
      },
      sessions: {
        take: 20,
        orderBy: { createdAt: 'desc' },
        select: { id: true, code: true, status: true, createdAt: true, expiresAt: true }
      },
      _count: {
        select: { sessions: true }
      }
    }
  });

  if (!qr) {
    throw new AppError('Printer QR not found', 404);
  }

  if (user && user.role !== 'SUPERADMIN') {
    if (!qr.machine || !qr.machine.companyId || qr.machine.companyId !== user.companyId) {
      throw new AppError('Access denied: You do not have permission to access this QR record', 403);
    }
  }

  return {
    ...qr,
    targetUrl: getPublicQrUrl(qr.publicCode)
  };
};

/**
 * Revokes a permanent QR code with mandatory audit reason (minimum 10 non-whitespace characters).
 * Uses row-level lock (FOR UPDATE) inside a transaction to eliminate TOCTOU race with session resolution.
 */
const revokePrinterQr = async (id, reason, user) => {
  if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
    throw new AppError('A meaningful revocation reason containing at least 10 non-whitespace characters is required', 400);
  }

  const operatorId = user ? (user.id || user.email) : 'SYSTEM';

  const result = await prisma.$transaction(async (tx) => {
    // Coordinate with resolvePrinterQr by locking the PrinterQr row
    const rows = await tx.$queryRawUnsafe(
      `SELECT pq.*, m."companyId" as machine_company_id
       FROM "PrinterQr" pq
       LEFT JOIN "Machine" m ON pq."machineId" = m.id
       WHERE pq.id = $1
       FOR UPDATE OF pq`,
      id
    );

    if (!rows || rows.length === 0) {
      throw new AppError('Printer QR not found', 404);
    }

    const existingQr = rows[0];

    // Franchisee tenant authorization check
    if (user && user.role !== 'SUPERADMIN') {
      if (!existingQr.machineId || !existingQr.machine_company_id || existingQr.machine_company_id !== user.companyId) {
        throw new AppError('Access denied: You do not own the printer associated with this QR', 403);
      }
    }

    if (existingQr.status === 'REVOKED') {
      return {
        ...existingQr,
        targetUrl: getPublicQrUrl(existingQr.publicCode),
        alreadyRevoked: true
      };
    }

    const updatedQr = await tx.printerQr.update({
      where: { id },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedBy: operatorId,
        revokedReason: reason.trim()
      },
      include: {
        machine: {
          select: { id: true, name: true, location: true, status: true, printerModel: true }
        }
      }
    });

    return {
      ...updatedQr,
      targetUrl: getPublicQrUrl(updatedQr.publicCode)
    };
  });

  logger.warn(`Printer QR [${result.publicCode}] for machine [${result.machineId}] REVOKED by [${operatorId}]. Reason: ${reason.trim()}`);

  return result;
};

/**
 * Replaces / rotates an existing QR code with a new secure token inside an atomic transaction.
 * Uses row-level lock (FOR UPDATE) to eliminate race conditions.
 */
const replacePrinterQr = async (id, data = {}, user = null) => {
  const reason = data.replacementReason || data.reason;
  if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
    throw new AppError('A meaningful replacement reason containing at least 10 non-whitespace characters is required', 400);
  }

  const operatorId = user ? (user.id || user.email) : 'SYSTEM';
  const newPublicCode = generateSecurePublicCode();
  const label = (data.label || 'Front Desk Counter').trim();

  const result = await prisma.$transaction(async (tx) => {
    // Acquire exclusive row lock on target PrinterQr record
    const rows = await tx.$queryRawUnsafe(
      `SELECT pq.*, m."companyId" as machine_company_id
       FROM "PrinterQr" pq
       LEFT JOIN "Machine" m ON pq."machineId" = m.id
       WHERE pq.id = $1
       FOR UPDATE OF pq`,
      id
    );

    if (!rows || rows.length === 0) {
      throw new AppError('Printer QR not found', 404);
    }

    const existingQr = rows[0];

    if (user && user.role !== 'SUPERADMIN') {
      if (!existingQr.machineId || !existingQr.machine_company_id || existingQr.machine_company_id !== user.companyId) {
        throw new AppError('Access denied: You do not own the printer associated with this QR', 403);
      }
    }

    if (existingQr.status === 'REPLACED') {
      throw new AppError('This QR code has already been replaced', 400);
    }

    const archivedOldQr = await tx.printerQr.update({
      where: { id },
      data: {
        status: 'REPLACED',
        revokedAt: new Date(),
        revokedBy: operatorId,
        revokedReason: reason.trim()
      }
    });

    const newQr = await tx.printerQr.create({
      data: {
        publicCode: newPublicCode,
        label,
        status: 'ACTIVE',
        machineId: existingQr.machineId,
        generatedBy: operatorId
      },
      include: {
        machine: {
          select: { id: true, name: true, location: true, status: true, printerModel: true }
        }
      }
    });

    return { archivedOldQr, newQr };
  });

  logger.info(`Printer QR [${result.archivedOldQr.publicCode}] replaced with [${result.newQr.publicCode}] by [${operatorId}]`);

  return {
    archivedOldQr: {
      ...result.archivedOldQr,
      targetUrl: getPublicQrUrl(result.archivedOldQr.publicCode)
    },
    newQr: {
      ...result.newQr,
      targetUrl: getPublicQrUrl(result.newQr.publicCode)
    }
  };
};

/**
 * Resolves a permanent physical QR code scanned by a customer and generates a fresh 60-minute session.
 * Eliminates TOCTOU race: Uses PostgreSQL row locking (FOR UPDATE) inside an interactive transaction.
 * Coordinate with revocation: if revocation is in progress or committed, resolution strictly fails closed (410).
 * Does NOT accept machineId from client. Binds session exclusively from server-side QR record.
 */
const resolvePrinterQr = async (publicCode) => {
  if (!publicCode || typeof publicCode !== 'string') {
    throw new AppError('publicCode is required to resolve a printer QR', 400);
  }

  const cleanCode = publicCode.trim();

  // Execute inside an interactive transaction with FOR UPDATE row locking on PrinterQr
  const { qr, session } = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT pq.*,
              m.id as machine_id,
              m.name as machine_name,
              m."printerModel" as machine_printer_model,
              m.location as machine_location,
              m.status as machine_status,
              m."paymentMode" as machine_payment_mode
       FROM "PrinterQr" pq
       LEFT JOIN "Machine" m ON pq."machineId" = m.id
       WHERE pq."publicCode" = $1
       FOR UPDATE OF pq`,
      cleanCode
    );

    if (!rows || rows.length === 0) {
      throw new AppError('Unrecognized printer QR code', 404);
    }

    const lockedQr = rows[0];

    if (lockedQr.status === 'REVOKED') {
      throw new AppError('This printer QR code has been revoked. Please scan the updated QR flyer on the printer counter.', 410);
    }

    if (lockedQr.status === 'REPLACED') {
      throw new AppError('This printer QR code has been replaced. Please scan the updated QR flyer on the printer counter.', 410);
    }

    if (lockedQr.status !== 'ACTIVE') {
      throw new AppError('This printer QR code is currently inactive.', 403);
    }

    if (!lockedQr.machineId || !lockedQr.machine_id) {
      throw new AppError('This QR code is not bound to a registered printer.', 400);
    }

    if (lockedQr.machine_status !== 'ACTIVE') {
      throw new AppError('This printer is currently offline or undergoing maintenance. Please contact shop staff.', 403);
    }

    // Create a brand new ephemeral customer session inside transaction
    const sessionCode = crypto.randomBytes(6).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 60 mins
    const sessionPaymentMode = lockedQr.machine_payment_mode || DEFAULT_PAYMENT_MODE;

    const createdSession = await tx.session.create({
      data: {
        code: sessionCode,
        machineId: lockedQr.machine_id,
        printerQrId: lockedQr.id,
        status: 'WAITING_FOR_MOBILE',
        paymentMode: sessionPaymentMode,
        expiresAt
      }
    });

    return { qr: lockedQr, session: createdSession };
  }, { maxWait: 10000, timeout: 10000 });

  const effectivePaymentMode = session.paymentMode || qr.machine_payment_mode || DEFAULT_PAYMENT_MODE;

  // Mint signed JWT session token
  const sessionToken = jwt.sign(
    {
      sessionId: session.code,
      machineId: qr.machine_id,
      paymentMode: effectivePaymentMode,
      type: 'session',
      role: 'mobile'
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const rawProfile = await getPricingProfile(qr.machine_id);
  const pricingProfile = serializePublicPricingProfile(rawProfile);
  const { env: cashfreeEnv } = resolveCashfreeEnv();

  const availability = await getMachineAvailability(qr.machine_id, prisma);
  const isReady = availability ? availability.isReady : false;
  const hardwareStatus = availability ? availability.status : 'UNKNOWN';
  const statusMessage = availability ? availability.statusMessage : 'Printer Status Unavailable';

  logger.info(`Customer scanned QR [${qr.publicCode}]; created fresh session [${session.code}] bound to printer [${qr.machine_id}] (Status: ${hardwareStatus}, PaymentMode: ${effectivePaymentMode})`);

  return {
    success: true,
    sessionCode: session.code,
    sessionToken,
    expiresAt: session.expiresAt,
    paymentMode: effectivePaymentMode,
    cashfreeEnv: cashfreeEnv || 'sandbox',
    pricingProfile,
    enableDemoPayment: effectivePaymentMode === 'DEMO_SIMULATION' && isDemoPaymentPermitted(),
    demoAccessCodeRequired: effectivePaymentMode === 'DEMO_SIMULATION' && isDemoPaymentPermitted() && isDemoAccessCodeRequired(),
    printer: {
      name: qr.machine_name || availability?.name,
      model: qr.machine_printer_model || availability?.printerModel || 'Unknown',
      location: qr.machine_location || availability?.location || 'Front Desk',
      isOnline: isReady,
      hardwareStatus,
      statusMessage,
      agentOnline: availability ? availability.agentOnline : false,
      paperStatus: availability ? availability.paperStatus : 'UNKNOWN',
      tonerStatus: availability ? availability.tonerStatus : 'UNKNOWN',
      jamStatus: availability ? availability.jamStatus : false
    }
  };
};

/**
 * Public metadata lookup for landing splash before session creation.
 * Excludes sensitive keys, secrets, and internal IDs.
 * Defensive Check: Fails closed (400) if QR is unbound.
 */
const getPublicPrinterQrInfo = async (publicCode) => {
  if (!publicCode || typeof publicCode !== 'string') {
    throw new AppError('publicCode is required', 400);
  }

  const qr = await prisma.printerQr.findUnique({
    where: { publicCode: publicCode.trim() },
    include: {
      machine: {
        select: { id: true, name: true, location: true, status: true, printerModel: true, paymentMode: true }
      }
    }
  });

  if (!qr) {
    throw new AppError('Unrecognized printer QR code', 404);
  }

  if (qr.status === 'REVOKED' || qr.status === 'REPLACED') {
    throw new AppError(`This printer QR code has been ${qr.status.toLowerCase()}. Please scan the updated QR flyer on the printer counter.`, 410);
  }

  if (!qr.machineId || !qr.machine) {
    throw new AppError('This QR code is not bound to a registered printer.', 400);
  }

  const rawProfile = await getPricingProfile(qr.machine.id);
  const pricingProfile = serializePublicPricingProfile(rawProfile);
  const { env: cashfreeEnv } = resolveCashfreeEnv();

  const availability = await getMachineAvailability(qr.machine.id, prisma);
  const isReady = availability ? availability.isReady : false;
  const hardwareStatus = availability ? availability.status : 'UNKNOWN';
  const statusMessage = availability ? availability.statusMessage : 'Printer Status Unavailable';

  return {
    success: true,
    status: qr.status,
    label: qr.label,
    paymentMode: qr.machine.paymentMode || DEFAULT_PAYMENT_MODE,
    cashfreeEnv: cashfreeEnv || 'sandbox',
    pricingProfile,
    printer: {
      name: qr.machine.name,
      model: qr.machine.printerModel || 'Unknown',
      location: qr.machine.location,
      isOnline: isReady,
      hardwareStatus,
      statusMessage,
      agentOnline: availability ? availability.agentOnline : false,
      paperStatus: availability ? availability.paperStatus : 'UNKNOWN',
      tonerStatus: availability ? availability.tonerStatus : 'UNKNOWN',
      jamStatus: availability ? availability.jamStatus : false
    }
  };
};

module.exports = {
  getPublicQrUrl,
  generateSecurePublicCode,
  generatePrinterQr,
  listPrinterQrs,
  getPrinterQrById,
  revokePrinterQr,
  replacePrinterQr,
  resolvePrinterQr,
  getPublicPrinterQrInfo,
  verifyMachineAccess
};
