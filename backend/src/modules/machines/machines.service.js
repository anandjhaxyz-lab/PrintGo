const prisma = require('../../utils/prisma');
const { Prisma } = require('@prisma/client');
const crypto = require('crypto');
const AppError = require('../../utils/AppError');
const { DEFAULT_PAYMENT_MODE } = require('../../constants/paymentModes');
const {
  ONLINE_HEARTBEAT_WINDOW_MS,
  computePrinterAvailability
} = require('../../services/printerAvailability.service');

/**
 * Computes whether a machine is ONLINE.
 * Rule:
 * - ONLINE only if status is ACTIVE, lastOnline exists, and its age is between 0 and 90 seconds inclusive.
 * - Missing, invalid, or future timestamps fail closed to false (OFFLINE).
 * - Non-ACTIVE statuses (e.g. INACTIVE, SUSPENDED) fail closed to false (OFFLINE).
 *
 * @param {Object} machine - Machine object containing status and lastOnline
 * @param {Date|number|string} [now=new Date()] - Reference timestamp for deterministic evaluation
 * @returns {boolean}
 */
const computeIsOnline = (machine, now = new Date()) => {
  if (!machine || typeof machine !== 'object') return false;
  if (machine.status !== 'ACTIVE') return false;
  if (!machine.lastOnline) return false;

  const lastOnlineDate = new Date(machine.lastOnline);
  const timeMs = lastOnlineDate.getTime();
  if (Number.isNaN(timeMs)) return false;

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (Number.isNaN(nowMs)) return false;

  const diffMs = nowMs - timeMs;
  // Age must be between 0 and 90,000 ms inclusive.
  // Future timestamps (diffMs < 0) or timestamps older than 90s fail closed to false.
  return diffMs >= 0 && diffMs <= ONLINE_HEARTBEAT_WINDOW_MS;
};

const getMachines = async (user) => {
  const where = {};
  if (user && user.role !== 'SUPERADMIN') {
    where.companyId = user.companyId;
  }

  const machines = await prisma.machine.findMany({
    where,
    include: { company: true, printerStatuses: { take: 1, orderBy: { timestamp: 'desc' } } }
  });

  return machines.map(m => {
    const availability = computePrinterAvailability(m, m.printerStatuses?.[0]);
    return {
      ...m,
      printerModel: m.printerModel?.trim() || 'Unknown',
      connectionType: m.connectionType?.trim() || 'Unknown',
      paymentMode: m.paymentMode || DEFAULT_PAYMENT_MODE,
      isOnline: availability.isReady,
      agentOnline: availability.agentOnline,
      hardwareStatus: availability.status,
      statusMessage: availability.statusMessage,
    };
  });
};

const getMachineById = async (id, user) => {
  const machine = await prisma.machine.findUnique({
    where: { id },
    include: { company: true, printerStatuses: { take: 1, orderBy: { timestamp: 'desc' } } }
  });
  if (!machine) throw new AppError('Machine not found', 404);
  
  if (user && user.role !== 'SUPERADMIN' && machine.companyId !== user.companyId) {
    throw new AppError('Access denied: Machine belongs to another company', 403);
  }
  
  const availability = computePrinterAvailability(machine, machine.printerStatuses?.[0]);
  return {
    ...machine,
    printerModel: machine.printerModel?.trim() || 'Unknown',
    connectionType: machine.connectionType?.trim() || 'Unknown',
    paymentMode: machine.paymentMode || DEFAULT_PAYMENT_MODE,
    isOnline: availability.isReady,
    agentOnline: availability.agentOnline,
    hardwareStatus: availability.status,
    statusMessage: availability.statusMessage,
  };
};

const createMachine = async (data) => {
  const { name, location, companyId, paymentMode } = data;
  const machineKey = crypto.randomBytes(32).toString('hex');
  
  const machine = await prisma.machine.create({
    data: {
      name,
      location,
      machineKey,
      companyId,
      status: 'INACTIVE',
      paymentMode: paymentMode || DEFAULT_PAYMENT_MODE
    },
    include: { company: true }
  });

  return {
    ...machine,
    isOnline: computeIsOnline(machine)
  };
};

const updateMachineStatus = async (id, status, io, user) => {
  // Check permission first
  await getMachineById(id, user);

  const machine = await prisma.machine.update({
    where: { id },
    data: { status },
    include: { company: true }
  });
  
  if (status === 'SUSPENDED') {
    io.to(`machine_${id}`).emit('machine_suspended', { message: 'Your machine is suspended.' });
  }
  
  return {
    ...machine,
    isOnline: computeIsOnline(machine)
  };
};

const getMachinesByCompany = async (companyId) => {
  const machines = await prisma.machine.findMany({
    where: { companyId },
    include: {
      company: true,
      printerStatuses: { take: 1, orderBy: { timestamp: 'desc' } },
      printJobs: { take: 50, orderBy: { createdAt: 'desc' } }
    }
  });

  return machines.map(m => {
    const availability = computePrinterAvailability(m, m.printerStatuses?.[0]);
    return {
      ...m,
      printerModel: m.printerModel?.trim() || 'Unknown',
      connectionType: m.connectionType?.trim() || 'Unknown',
      paymentMode: m.paymentMode || DEFAULT_PAYMENT_MODE,
      isOnline: availability.isReady,
      agentOnline: availability.agentOnline,
      hardwareStatus: availability.status,
      statusMessage: availability.statusMessage,
    };
  });
};

const updateMachinePaymentMode = async (id, paymentMode, user, io) => {
  const machine = await getMachineById(id, user);

  const validModes = ['CASH_AT_COUNTER', 'DEMO_SIMULATION', 'CASHFREE_ONLINE'];
  if (!validModes.includes(paymentMode)) {
    throw new AppError(`Invalid payment mode. Must be one of: ${validModes.join(', ')}`, 400);
  }

  // Mandatory Correction 5: Payment mode availability guards
  if (paymentMode === 'CASHFREE_ONLINE') {
    const { validateCashfreeConfig, isCashfreeKycApproved } = require('../../config/cashfree.config');
    const validation = validateCashfreeConfig();
    if (!validation.isValid) {
      throw new AppError(`Cashfree Online is unavailable: ${validation.reason || 'Required gateway credentials are not configured.'}`, 400);
    }
    if (!isCashfreeKycApproved()) {
      throw new AppError('Cashfree Online is unavailable: Merchant KYC verification is pending approval with Cashfree.', 400);
    }
  }

  if (paymentMode === 'DEMO_SIMULATION') {
    const { isDemoPaymentPermitted } = require('../../utils/demoPaymentGuard');
    if (!isDemoPaymentPermitted()) {
      throw new AppError('Demo Simulation is disabled: Only permitted in the authorized Staging environment with DEMO_PAYMENT_ACCESS_CODE.', 400);
    }
  }

  const oldMode = machine.paymentMode || DEFAULT_PAYMENT_MODE;
  const updatedMachine = await prisma.machine.update({
    where: { id },
    data: { paymentMode },
    include: { company: true }
  });

  // Audit log
  if (prisma.auditLog && typeof prisma.auditLog.create === 'function') {
    try {
      await prisma.auditLog.create({
        data: {
          entity: 'Machine',
          entityId: id,
          action: 'UPDATE_PAYMENT_MODE',
          performedBy: user.email || user.id,
          changes: JSON.stringify({
            previousMode: oldMode,
            newMode: paymentMode,
            machineId: id,
            companyId: machine.companyId,
            timestamp: new Date().toISOString()
          })
        }
      });
    } catch (auditErr) {
      console.warn('Failed to record audit log for payment mode update:', auditErr.message);
    }
  }

  if (io) {
    const payload = {
      machineId: id,
      paymentMode,
      timestamp: new Date().toISOString()
    };
    if (updatedMachine.companyId) {
      io.to(`company_${updatedMachine.companyId}`).emit('printer_status_update', payload);
    }
    io.to('superadmins').emit('printer_status_update', payload);
    io.to('admins').emit('printer_status_update', payload);
  }

  return {
    ...updatedMachine,
    paymentMode: updatedMachine.paymentMode
  };
};

const getPaymentModeCapabilities = () => {
  const { validateCashfreeConfig, isCashfreeKycApproved } = require('../../config/cashfree.config');
  const { isDemoPaymentPermitted } = require('../../utils/demoPaymentGuard');
  const cfValidation = validateCashfreeConfig();
  const kycApproved = isCashfreeKycApproved();
  const demoPermitted = isDemoPaymentPermitted();

  return {
    CASH_AT_COUNTER: {
      available: true,
      label: 'Cash at Counter',
      description: 'Customer pays cashier at the counter; printing starts after cash confirmation.'
    },
    DEMO_SIMULATION: {
      available: demoPermitted,
      label: 'Demo Simulation',
      description: demoPermitted
        ? 'Supervised simulation on authorized Staging with DEMO_PAYMENT_ACCESS_CODE.'
        : 'Disabled in Production / Unauthorized environments.'
    },
    CASHFREE_ONLINE: {
      available: cfValidation.isValid && kycApproved,
      label: 'Cashfree Online',
      description: (cfValidation.isValid && kycApproved)
        ? 'Live UPI, Cards, and NetBanking via Cashfree Payment Gateway.'
        : (!cfValidation.isValid
            ? `Unavailable: ${cfValidation.reason || 'Missing gateway credentials'}`
            : 'Unavailable: Merchant KYC verification is pending approval with Cashfree.')
    }
  };
};

/**
 * WP-2H.1: Builds unambiguous, sorted canonical JSON payload for challenge-response enrollment.
 * Guaranteed exact byte-for-byte reproducibility between Agent signer and Backend verifier.
 */
function buildCanonicalChallengePayload({
  protocolVersion = 1,
  challengeId,
  challengeNonce,
  machineId,
  installationId,
  purpose = 'INSTALLATION_KEY_ENROLLMENT',
  issuedAt,
  expiresAt
}) {
  return JSON.stringify({
    challengeId: String(challengeId),
    challengeNonce: String(challengeNonce),
    expiresAt: new Date(expiresAt).toISOString(),
    installationId: String(installationId).trim(),
    issuedAt: new Date(issuedAt).toISOString(),
    machineId: String(machineId),
    protocolVersion: Number(protocolVersion),
    purpose: String(purpose)
  });
}

const CHALLENGE_TTL_MS = 60 * 1000;
const CHALLENGE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_CHALLENGES_PER_WINDOW = 5;
const MAX_ACTIVE_PENDING_CHALLENGES = 3;
const CHALLENGE_CLEANUP_BATCH_SIZE = 500;

const cleanupEnrollmentChallenges = async () => {
  return prisma.$executeRaw(Prisma.sql`
    WITH stale AS (
      SELECT id
      FROM "InstallationEnrollmentChallenge"
      WHERE (
        status = 'PENDING'
        AND "expiresAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours'
      ) OR (
        status IN ('CONSUMED', 'EXPIRED')
        AND "expiresAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days'
      )
      ORDER BY "expiresAt" ASC
      LIMIT 500
    )
    DELETE FROM "InstallationEnrollmentChallenge"
    WHERE id IN (SELECT id FROM stale)
  `);
};
function resetChallengeRateLimits() {
  return true;
}

const issueEnrollmentChallenge = async ({ machine, payload, clientIp }) => {
  if (!machine || !machine.id) throw new AppError('Authentication required: Valid machine identity missing.', 401, 'MACHINE_AUTH_REQUIRED');
  const { installationId, purpose } = payload || {};
  if (!installationId || typeof installationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(installationId.trim())) {
    throw new AppError('Invalid installationId: Must be a valid non-empty UUID string.', 400, 'INVALID_INSTALLATION_ID');
  }
  const effectivePurpose = purpose || 'INSTALLATION_KEY_ENROLLMENT';
  if (effectivePurpose !== 'INSTALLATION_KEY_ENROLLMENT') throw new AppError('Invalid challenge purpose: Must be INSTALLATION_KEY_ENROLLMENT.', 400, 'INVALID_PURPOSE');

  const normalizedInstallationId = installationId.trim();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const challengeId = crypto.randomUUID();
  const challengeNonceHex = crypto.randomBytes(32).toString('hex');
  const nonceHash = crypto.createHash('sha256').update(challengeNonceHex).digest('hex');

  await prisma.$transaction(async (tx) => {
    if (!tx || typeof tx.$queryRaw !== 'function' || typeof tx.$executeRaw !== 'function') {
      throw new AppError('Secure challenge issuance unavailable: PostgreSQL row-lock and atomic SQL capabilities are required.', 503, 'CHALLENGE_STORAGE_UNAVAILABLE');
    }
    const machineRows = await tx.$queryRaw(Prisma.sql`
      SELECT id FROM "Machine" WHERE id = ${machine.id} FOR UPDATE
    `);
    if (!machineRows || machineRows.length !== 1) throw new AppError('Machine not found.', 404, 'MACHINE_NOT_FOUND');

    const rateRows = await tx.$queryRaw(Prisma.sql`
      SELECT COUNT(*)::int AS "requestCount"
      FROM "InstallationEnrollmentChallenge"
      WHERE "machineId" = ${machine.id}
        AND "issuedAt" > (NOW() AT TIME ZONE 'UTC') - INTERVAL '60 seconds'
    `);
    const requestCount = Number(rateRows && rateRows[0] && rateRows[0].requestCount || 0);
    if (requestCount >= MAX_CHALLENGES_PER_WINDOW) {
      throw new AppError('Too many challenge requests for this machine. Maximum 5 requests per minute allowed.', 429, 'CHALLENGE_RATE_LIMITED');
    }

    await tx.$executeRaw(Prisma.sql`
      UPDATE "InstallationEnrollmentChallenge"
      SET status = 'EXPIRED'
      WHERE "machineId" = ${machine.id} AND status = 'PENDING'
        AND "expiresAt" <= (NOW() AT TIME ZONE 'UTC')
    `);
    await tx.$executeRaw(Prisma.sql`
      WITH keep_pending AS (
        SELECT id FROM "InstallationEnrollmentChallenge"
        WHERE "machineId" = ${machine.id} AND status = 'PENDING'
          AND "expiresAt" > (NOW() AT TIME ZONE 'UTC')
        ORDER BY "issuedAt" DESC, id DESC LIMIT 2
      )
      UPDATE "InstallationEnrollmentChallenge"
      SET status = 'EXPIRED'
      WHERE "machineId" = ${machine.id} AND status = 'PENDING'
        AND id NOT IN (SELECT id FROM keep_pending)
    `);
    await tx.installationEnrollmentChallenge.create({
      data: {
        challengeId, machineId: machine.id, installationId: normalizedInstallationId,
        nonceHash, purpose: effectivePurpose, status: 'PENDING',
        issuedAt, expiresAt, consumedByIp: clientIp || null
      }
    });
  }, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 10000 });

  // Opportunistic bounded cleanup; a periodic server maintenance timer also invokes this.
  try {
    await cleanupEnrollmentChallenges();
  } catch (cleanupError) {
    console.warn('Enrollment challenge retention cleanup deferred:', cleanupError.message);
  }
  return {
    success: true, protocolVersion: 1, challengeId, challengeNonce: challengeNonceHex,
    machineId: machine.id, installationId: normalizedInstallationId, purpose: effectivePurpose,
    issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString()
  };
};
/**
 * WP-2H.2: Enrolls an asymmetric ECDSA P-256 installation public key using:
 * 1. Consistent PostgreSQL row-locking order: Machine row first, then Challenge row second.
 * 2. True database serialization via FOR UPDATE.
 * 3. Conditional compare-and-set challenge consumption requiring exactly 1 affected row.
 * 4. Consistent challenge burning on unauthorized key replacement without rolling back the challenge state.
 */
const enrollInstallationKey = async ({ machine, payload, clientIp }) => {
  if (!machine || !machine.id) {
    throw new AppError('Authentication required: Valid machine identity missing.', 401, 'MACHINE_AUTH_REQUIRED');
  }

  const {
    challengeId,
    challengeNonce,
    installationId,
    publicKey,
    keyAlgorithm,
    keyFormat,
    keyFingerprint,
    signature,
    protocolVersion = 1
  } = payload || {};

  // Reject deprecated client-timestamp-only proof
  if (!challengeId || !challengeNonce || !signature) {
    throw new AppError('Challenge-response required: Missing challengeId, challengeNonce, or signature. Client-timestamp-only proofs are rejected.', 400, 'CHALLENGE_REQUIRED');
  }

  // 1. Validate installationId
  if (!installationId || typeof installationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(installationId.trim())) {
    throw new AppError('Invalid installationId: Must be a valid non-empty UUID string.', 400, 'INVALID_INSTALLATION_ID');
  }

  // 2. Validate algorithm and format
  if (keyAlgorithm !== 'ECDSA_P256') {
    throw new AppError('Unsupported key algorithm: Must be ECDSA_P256.', 400, 'UNSUPPORTED_ALGORITHM');
  }
  if (keyFormat !== 'spki_pem') {
    throw new AppError('Unsupported key format: Must be spki_pem.', 400, 'UNSUPPORTED_FORMAT');
  }

  // 3. Validate public key syntax and cryptographic properties
  if (!publicKey || typeof publicKey !== 'string') {
    throw new AppError('Missing public key: publicKey is required.', 400, 'MISSING_PUBLIC_KEY');
  }

  const trimmedKey = publicKey.trim();
  if (!trimmedKey.startsWith('-----BEGIN PUBLIC KEY-----') || !trimmedKey.endsWith('-----END PUBLIC KEY-----')) {
    throw new AppError('Invalid public key format: Must be standard SPKI PEM.', 400, 'MALFORMED_PUBLIC_KEY');
  }

  let pubKeyObj;
  try {
    pubKeyObj = crypto.createPublicKey(trimmedKey);
  } catch (err) {
    throw new AppError(`Malformed public key: ${err.message}`, 400, 'MALFORMED_PUBLIC_KEY');
  }

  if (pubKeyObj.asymmetricKeyType !== 'ec') {
    throw new AppError('Invalid key type: Public key must be an elliptic curve (ec) key.', 400, 'INVALID_KEY_TYPE');
  }

  // Verify curve is prime256v1 / P-256
  const jwk = pubKeyObj.export({ format: 'jwk' });
  if (jwk.crv !== 'P-256') {
    throw new AppError(`Invalid curve: Expected P-256 / prime256v1, got ${jwk.crv}.`, 400, 'INVALID_CURVE');
  }

  // 4. Compute and verify fingerprint
  const spkiDer = pubKeyObj.export({ type: 'spki', format: 'der' });
  const computedFingerprint = crypto.createHash('sha256').update(spkiDer).digest('hex');
  if (keyFingerprint && keyFingerprint.trim().toLowerCase() !== computedFingerprint.toLowerCase()) {
    throw new AppError('Key fingerprint mismatch: Provided fingerprint does not match computed SHA-256.', 400, 'FINGERPRINT_MISMATCH');
  }

  // 5. Execute atomic challenge validation, row-locking, and enrollment inside an isolated database transaction
  const result = await prisma.$transaction(async (tx) => {
    if (!tx || typeof tx.$queryRaw !== 'function' || typeof tx.$executeRaw !== 'function') {
      throw new AppError('Secure enrollment unavailable: PostgreSQL row-lock and conditional SQL capabilities are required.', 503, 'ENROLLMENT_STORAGE_UNAVAILABLE');
    }
    // -------------------------------------------------------------------------
    // LOCK ACQUISITION ORDER:
    // 1. Primary Entity Lock: Machine row FIRST
    // 2. Secondary Entity Lock: InstallationEnrollmentChallenge row SECOND
    // This consistent global order prevents deadlock between concurrent transactions.
    // -------------------------------------------------------------------------

    let lockedMachine;
    if (typeof tx.$queryRaw === 'function') {
      const machineRows = await tx.$queryRaw(Prisma.sql`
        SELECT id, "status", "activeInstallationId", "installationPublicKey",
               "installationKeyAlgorithm", "installationKeyFormat", "installationKeyFingerprint",
               "installationEnrolledAt", "installationKeyStatus"
        FROM "Machine"
        WHERE id = ${machine.id}
        FOR UPDATE
      `);
      if (!machineRows || machineRows.length === 0) {
        throw new AppError('Machine not found.', 404, 'MACHINE_NOT_FOUND');
      }
      lockedMachine = machineRows[0];
    }

    let lockedChallenge;
    if (typeof tx.$queryRaw === 'function') {
      const challengeRows = await tx.$queryRaw(Prisma.sql`
        SELECT id, "challengeId", "machineId", "installationId", "nonceHash",
               "purpose", "status", "issuedAt", "expiresAt", "consumedAt", "consumedByIp"
        FROM "InstallationEnrollmentChallenge"
        WHERE "challengeId" = ${challengeId}
        FOR UPDATE
      `);
      if (!challengeRows || challengeRows.length === 0) {
        throw new AppError('Challenge not found or invalid.', 404, 'CHALLENGE_NOT_FOUND');
      }
      lockedChallenge = challengeRows[0];
    }

    // Re-validate challenge state after acquiring exclusive row lock
    if (lockedChallenge.status === 'CONSUMED') {
      throw new AppError('Challenge already consumed. Challenges are single-use only.', 409, 'CHALLENGE_ALREADY_CONSUMED');
    }

    const now = new Date();
    if (now > new Date(lockedChallenge.expiresAt) || lockedChallenge.status === 'EXPIRED') {
      throw new AppError('Challenge expired. Lifetime is 60 seconds.', 410, 'CHALLENGE_EXPIRED');
    }

    if (lockedChallenge.machineId !== machine.id) {
      throw new AppError('Challenge machine identity mismatch.', 403, 'CHALLENGE_MACHINE_MISMATCH');
    }

    if (lockedChallenge.installationId !== installationId.trim()) {
      throw new AppError('Challenge installation identity mismatch.', 403, 'CHALLENGE_INSTALLATION_MISMATCH');
    }

    if (lockedChallenge.purpose !== 'INSTALLATION_KEY_ENROLLMENT') {
      throw new AppError('Challenge purpose mismatch.', 400, 'CHALLENGE_PURPOSE_MISMATCH');
    }

    // Verify nonce hash
    const computedNonceHash = crypto.createHash('sha256').update(challengeNonce).digest('hex');
    if (computedNonceHash !== lockedChallenge.nonceHash) {
      throw new AppError('Tampered challenge nonce.', 400, 'TAMPERED_CHALLENGE_NONCE');
    }

    // Reconstruct canonical payload and verify ECDSA signature
    const canonicalPayload = buildCanonicalChallengePayload({
      protocolVersion,
      challengeId,
      challengeNonce,
      machineId: machine.id,
      installationId: installationId.trim(),
      purpose: lockedChallenge.purpose,
      issuedAt: lockedChallenge.issuedAt,
      expiresAt: lockedChallenge.expiresAt
    });

    const isSigValid = crypto.verify(
      'sha256',
      Buffer.from(canonicalPayload, 'utf8'),
      pubKeyObj,
      Buffer.from(signature, 'base64')
    );

    if (!isSigValid) {
      throw new AppError('Invalid enrollment signature: Signature does not verify against public key.', 400, 'INVALID_ENROLLMENT_SIGNATURE');
    }

    // Check key replacement guard on the locked Machine row
    if (lockedMachine.installationKeyStatus === 'ACTIVE' && lockedMachine.installationPublicKey) {
      const isSameKey = lockedMachine.installationPublicKey.trim() === trimmedKey &&
                        lockedMachine.activeInstallationId === installationId.trim();

      if (isSameKey) {
        // Idempotent re-enrollment of the identical active key
        const affected = await tx.$executeRaw(Prisma.sql`
            UPDATE "InstallationEnrollmentChallenge"
            SET status = 'CONSUMED',
                "consumedAt" = (NOW() AT TIME ZONE 'UTC'),
                "consumedByIp" = ${clientIp || null}
            WHERE "challengeId" = ${challengeId}
              AND "machineId" = ${machine.id}
              AND "installationId" = ${installationId.trim()}
              AND status = 'PENDING'
              AND purpose = 'INSTALLATION_KEY_ENROLLMENT'
              AND "expiresAt" > (NOW() AT TIME ZONE 'UTC')
          `);

        if (affected !== 1) {
          throw new AppError('Challenge already consumed or invalid.', 409, 'CHALLENGE_ALREADY_CONSUMED');
        }

        return {
          success: true,
          status: 'ALREADY_ENROLLED',
          machineId: lockedMachine.id,
          installationId: lockedMachine.activeInstallationId,
          keyFingerprint: lockedMachine.installationKeyFingerprint,
          keyAlgorithm: lockedMachine.installationKeyAlgorithm,
          keyFormat: lockedMachine.installationKeyFormat,
          keyStatus: lockedMachine.installationKeyStatus,
          enrolledAt: lockedMachine.installationEnrolledAt
        };
      }

      // Unauthorized key replacement: Burn challenge atomically without modifying Machine.
      // Returning rejection object allows transaction to COMMIT the challenge consumption,
      // permanently preventing challenge replay while rejecting the caller with 409.
      const affected = await tx.$executeRaw(Prisma.sql`
          UPDATE "InstallationEnrollmentChallenge"
          SET status = 'CONSUMED',
              "consumedAt" = (NOW() AT TIME ZONE 'UTC'),
              "consumedByIp" = ${clientIp || null}
          WHERE "challengeId" = ${challengeId}
            AND "machineId" = ${machine.id}
            AND "installationId" = ${installationId.trim()}
            AND status = 'PENDING'
            AND purpose = 'INSTALLATION_KEY_ENROLLMENT'
            AND "expiresAt" > (NOW() AT TIME ZONE 'UTC')
        `);

      if (affected !== 1) {
        throw new AppError('Challenge already consumed or invalid.', 409, 'CHALLENGE_ALREADY_CONSUMED');
      }

      return {
        __rejection: {
          statusCode: 409,
          errorCode: 'UNAUTHORIZED_KEY_REPLACEMENT',
          message: 'Unauthorized key replacement: Machine is already enrolled with an active installation key. Recommissioning workflow required.'
        }
      };
    }

    // First enrollment (or Machine has no active key)
    // 1. Conditional compare-and-set: consume challenge
    const affected = await tx.$executeRaw(Prisma.sql`
        UPDATE "InstallationEnrollmentChallenge"
        SET status = 'CONSUMED',
            "consumedAt" = (NOW() AT TIME ZONE 'UTC'),
            "consumedByIp" = ${clientIp || null}
        WHERE "challengeId" = ${challengeId}
          AND "machineId" = ${machine.id}
          AND "installationId" = ${installationId.trim()}
          AND status = 'PENDING'
          AND purpose = 'INSTALLATION_KEY_ENROLLMENT'
          AND "expiresAt" > (NOW() AT TIME ZONE 'UTC')
      `);

    if (affected !== 1) {
      throw new AppError('Challenge conditional consumption failed. Challenge is invalid or already consumed.', 409, 'CHALLENGE_ALREADY_CONSUMED');
    }

    // 2. Atomically commit Machine enrollment
    const enrolledAt = new Date();
    const updated = await tx.machine.update({
      where: { id: machine.id },
      data: {
        activeInstallationId: installationId.trim(),
        installationPublicKey: trimmedKey,
        installationKeyAlgorithm: 'ECDSA_P256',
        installationKeyFormat: 'spki_pem',
        installationKeyFingerprint: computedFingerprint,
        installationEnrolledAt: enrolledAt,
        installationKeyStatus: 'ACTIVE'
      }
    });

    return {
      success: true,
      status: 'ENROLLED',
      machineId: updated.id,
      installationId: updated.activeInstallationId,
      keyFingerprint: updated.installationKeyFingerprint,
      keyAlgorithm: updated.installationKeyAlgorithm,
      keyFormat: updated.installationKeyFormat,
      keyStatus: updated.installationKeyStatus,
      enrolledAt: updated.installationEnrolledAt
    };
  });

  // If the transaction committed a rejection (such as burning a challenge on key replacement),
  // throw the corresponding AppError now so the caller receives the 409 error.
  if (result && result.__rejection) {
    throw new AppError(
      result.__rejection.message,
      result.__rejection.statusCode,
      result.__rejection.errorCode
    );
  }

  return result;
};

const getInstallationKeyStatus = async (machineId) => {
  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    select: {
      id: true,
      activeInstallationId: true,
      installationPublicKey: true,
      installationKeyAlgorithm: true,
      installationKeyFormat: true,
      installationKeyFingerprint: true,
      installationEnrolledAt: true,
      installationKeyStatus: true
    }
  });
  if (!machine) {
    throw new AppError('Machine not found.', 404);
  }
  return machine;
};

module.exports = {
  ONLINE_HEARTBEAT_WINDOW_MS,
  computeIsOnline,
  getMachines,
  getMachineById,
  createMachine,
  updateMachineStatus,
  getMachinesByCompany,
  updateMachinePaymentMode,
  getPaymentModeCapabilities,
  buildCanonicalChallengePayload,
  issueEnrollmentChallenge,
  cleanupEnrollmentChallenges,
  enrollInstallationKey,
  getInstallationKeyStatus,
  resetChallengeRateLimits
};
