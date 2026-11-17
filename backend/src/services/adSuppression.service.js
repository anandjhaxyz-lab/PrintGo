/**
 * Machine Advertisement Suppression & Audit Service
 *
 * Implements:
 * - PERMANENT and TEMPORARY suppression
 * - Approved presets: 2h, 6h, 12h, 24h, and custom ISO datetime
 * - Input validation & UTC timestamp conversion
 * - Atomic lazy expiry restoration and exact-once audit logging
 * - ActivityLog & AuditLog recording for full operator compliance
 * - Ownership checks: SUPERADMIN (fleet) vs FRANCHISEE (own company only)
 */

const prisma = require('../utils/prisma');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const VALID_PRESET_HOURS = new Set([2, 6, 12, 24]);

/**
 * Validates that the requesting user owns the machine or is SUPERADMIN.
 */
const assertMachineOwnership = async (machineId, user) => {
  if (!machineId) throw new AppError('Machine ID is required', 400);

  const machine = await prisma.machine.findUnique({
    where: { id: machineId },
    include: { company: true }
  });

  if (!machine) {
    throw new AppError('Machine not found', 404);
  }

  if (user && user.role !== 'SUPERADMIN' && machine.companyId !== user.companyId) {
    throw new AppError('Access denied: You do not have permission to manage this machine', 403);
  }

  return machine;
};

/**
 * Evaluates whether a machine currently has advertisements suppressed.
 * Resumes ads immediately if TEMPORARY suppression has expired, and triggers
 * atomic background database state cleanup.
 *
 * @param {Object} machine - Machine database record
 * @param {Date} [now=new Date()]
 * @returns {{ isSuppressed: boolean, reason: string|null, until: Date|null }}
 */
const evaluateAdSuppression = (machine, now = new Date()) => {
  if (!machine) {
    return { isSuppressed: false, reason: null, until: null };
  }

  // Level 1: Permanent Suppression (Hard owner override)
  if (machine.adSuppressionMode === 'PERMANENT') {
    return {
      isSuppressed: true,
      reason: machine.adSuppressionReason || 'Permanently disabled by owner',
      until: null
    };
  }

  // Level 2: Temporary Suppression
  if (machine.adSuppressionMode === 'TEMPORARY') {
    if (machine.adSuppressionUntil && new Date(machine.adSuppressionUntil) > now) {
      return {
        isSuppressed: true,
        reason: machine.adSuppressionReason || 'Temporarily silenced by owner',
        until: new Date(machine.adSuppressionUntil)
      };
    }

    // Expiry timestamp has passed: ads resume immediately
    triggerAsyncAtomicExpiry(machine.id, machine.adSuppressionUntil).catch((err) => {
      logger.warn(`Failed to execute async atomic expiry for machine ${machine.id}: ${err.message}`);
    });

    return { isSuppressed: false, reason: null, until: null };
  }

  return { isSuppressed: false, reason: null, until: null };
};

/**
 * Executes conditional atomic state reset and single ActivityLog insertion
 * inside one interactive Prisma transaction.
 *
 * @param {string} machineId
 * @param {Date|string} expectedUntil
 */
const triggerAsyncAtomicExpiry = async (machineId, expectedUntil) => {
  if (!machineId || !expectedUntil) return;

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Conditional update: only updates if machine is STILL in TEMPORARY mode
      // with the matching expiry timestamp.
      const result = await tx.machine.updateMany({
        where: {
          id: machineId,
          adSuppressionMode: 'TEMPORARY',
          adSuppressionUntil: new Date(expectedUntil)
        },
        data: {
          adSuppressionMode: 'ENABLED',
          adSuppressionUntil: null,
          adSuppressionReason: null
        }
      });

      // Exactly-once guard: If another concurrent request updated it, count is 0
      if (result.count === 0) {
        return;
      }

      // 2. Insert audit log inside the SAME transaction
      await tx.activityLog.create({
        data: {
          action: 'AD_SUPPRESSION_EXPIRED',
          details: JSON.stringify({
            machineId,
            expiredAt: new Date(expectedUntil).toISOString(),
            resumedAt: new Date().toISOString(),
            mechanism: 'ATOMIC_LAZY_EVALUATION'
          }),
          machineId,
          userId: null
        }
      });
    }, {
      isolationLevel: 'ReadCommitted',
      timeout: 5000
    });
  } catch (err) {
    logger.warn(`Ad suppression atomic expiry error for machine ${machineId}: ${err.message}`);
  }
};

/**
 * Sets permanent or temporary advertisement suppression for a machine.
 */
const setAdSuppression = async (machineId, payload, user, ipAddress) => {
  const machine = await assertMachineOwnership(machineId, user);
  const { mode, durationHours, customUntil, reason } = payload || {};

  if (!mode || (mode !== 'PERMANENT' && mode !== 'TEMPORARY')) {
    throw new AppError("Invalid mode: Must be 'PERMANENT' or 'TEMPORARY'", 400);
  }

  let suppressionUntil = null;
  const now = new Date();

  if (mode === 'TEMPORARY') {
    if (durationHours !== undefined) {
      const parsedHours = Number(durationHours);
      if (!VALID_PRESET_HOURS.has(parsedHours)) {
        throw new AppError(`Invalid durationHours: Must be one of ${Array.from(VALID_PRESET_HOURS).join(', ')}`, 400);
      }
      suppressionUntil = new Date(now.getTime() + parsedHours * 3600 * 1000);
    } else if (customUntil) {
      const parsedDate = new Date(customUntil);
      if (isNaN(parsedDate.getTime())) {
        throw new AppError('Invalid customUntil date format. Expected ISO-8601 string.', 400);
      }
      if (parsedDate <= now) {
        throw new AppError('customUntil must be a future date and time', 400);
      }
      suppressionUntil = parsedDate;
    } else {
      throw new AppError("TEMPORARY suppression requires either 'durationHours' (2, 6, 12, 24) or a future 'customUntil' date", 400);
    }
  }

  const cleanReason = reason && typeof reason === 'string' ? reason.trim().slice(0, 500) : null;

  const [updatedMachine] = await prisma.$transaction([
    prisma.machine.update({
      where: { id: machineId },
      data: {
        adSuppressionMode: mode,
        adSuppressionUntil: suppressionUntil,
        adSuppressionReason: cleanReason,
        adSuppressedBy: user?.id || null,
        adSuppressedAt: now
      }
    }),
    prisma.activityLog.create({
      data: {
        action: `AD_SUPPRESSION_${mode}`,
        details: JSON.stringify({
          machineId,
          machineName: machine.name,
          mode,
          until: suppressionUntil ? suppressionUntil.toISOString() : null,
          durationHours: durationHours || null,
          reason: cleanReason,
          previousMode: machine.adSuppressionMode,
          performedByRole: user?.role
        }),
        userId: user?.id || null,
        machineId,
        ipAddress: ipAddress || null
      }
    }),
    prisma.auditLog.create({
      data: {
        entity: 'Machine',
        entityId: machineId,
        action: 'UPDATE_AD_SUPPRESSION',
        changes: JSON.stringify({
          before: { mode: machine.adSuppressionMode, until: machine.adSuppressionUntil },
          after: { mode, until: suppressionUntil, reason: cleanReason }
        }),
        performedBy: user?.id || 'SYSTEM'
      }
    })
  ]);

  logger.info(`Ad suppression set to ${mode} for machine ${machine.name} (${machineId}) by user ${user?.id}`);

  return {
    success: true,
    machineId: updatedMachine.id,
    adSuppressionMode: updatedMachine.adSuppressionMode,
    adSuppressionUntil: updatedMachine.adSuppressionUntil,
    adSuppressionReason: updatedMachine.adSuppressionReason,
    adSuppressedAt: updatedMachine.adSuppressedAt
  };
};

/**
 * Resumes advertisements (cancels permanent or temporary suppression).
 */
const cancelAdSuppression = async (machineId, user, ipAddress) => {
  const machine = await assertMachineOwnership(machineId, user);

  if (machine.adSuppressionMode === 'ENABLED') {
    return {
      success: true,
      message: 'Advertisements are already enabled for this machine',
      adSuppressionMode: 'ENABLED'
    };
  }

  const [updatedMachine] = await prisma.$transaction([
    prisma.machine.update({
      where: { id: machineId },
      data: {
        adSuppressionMode: 'ENABLED',
        adSuppressionUntil: null,
        adSuppressionReason: null,
        adSuppressedBy: null,
        adSuppressedAt: null
      }
    }),
    prisma.activityLog.create({
      data: {
        action: 'AD_SUPPRESSION_RESUMED',
        details: JSON.stringify({
          machineId,
          machineName: machine.name,
          previousMode: machine.adSuppressionMode,
          previousUntil: machine.adSuppressionUntil,
          resumedAt: new Date().toISOString(),
          performedByRole: user?.role
        }),
        userId: user?.id || null,
        machineId,
        ipAddress: ipAddress || null
      }
    }),
    prisma.auditLog.create({
      data: {
        entity: 'Machine',
        entityId: machineId,
        action: 'RESUME_AD_SUPPRESSION',
        changes: JSON.stringify({
          before: { mode: machine.adSuppressionMode, until: machine.adSuppressionUntil },
          after: { mode: 'ENABLED', until: null }
        }),
        performedBy: user?.id || 'SYSTEM'
      }
    })
  ]);

  logger.info(`Ad suppression cancelled for machine ${machine.name} (${machineId}) by user ${user?.id}`);

  return {
    success: true,
    message: 'Advertisements resumed successfully',
    machineId: updatedMachine.id,
    adSuppressionMode: 'ENABLED',
    adSuppressionUntil: null
  };
};

/**
 * Retrieves current suppression status and remaining time for a machine.
 */
const getAdSuppressionStatus = async (machineId, user) => {
  const machine = await assertMachineOwnership(machineId, user);
  const now = new Date();
  const evaluation = evaluateAdSuppression(machine, now);

  const remainingMs = evaluation.until ? Math.max(0, evaluation.until.getTime() - now.getTime()) : null;

  return {
    success: true,
    machineId: machine.id,
    machineName: machine.name,
    adSuppressionMode: machine.adSuppressionMode,
    isSuppressed: evaluation.isSuppressed,
    adSuppressionUntil: machine.adSuppressionUntil,
    adSuppressionReason: machine.adSuppressionReason,
    remainingMs,
    remainingSeconds: remainingMs !== null ? Math.round(remainingMs / 1000) : null,
    remainingHours: remainingMs ? (remainingMs / (3600 * 1000)).toFixed(2) : null
  };
};

module.exports = {
  assertMachineOwnership,
  evaluateAdSuppression,
  triggerAsyncAtomicExpiry,
  setAdSuppression,
  cancelAdSuppression,
  getAdSuppressionStatus,
  VALID_PRESET_HOURS
};
