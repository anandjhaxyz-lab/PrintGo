const prisma = require('../../utils/prisma');
const crypto = require('crypto');
const AppError = require('../../utils/AppError');
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
      paymentMode: m.paymentMode || 'CASHFREE_ONLINE',
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
    paymentMode: machine.paymentMode || 'CASHFREE_ONLINE',
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
      paymentMode: paymentMode || 'CASH_AT_COUNTER'
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
      paymentMode: m.paymentMode || 'CASHFREE_ONLINE',
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

  const oldMode = machine.paymentMode || 'CASHFREE_ONLINE';
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
    io.to('admins').emit('printer_status_update', {
      machineId: id,
      paymentMode,
      timestamp: new Date().toISOString()
    });
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

module.exports = {
  ONLINE_HEARTBEAT_WINDOW_MS,
  computeIsOnline,
  getMachines,
  getMachineById,
  createMachine,
  updateMachineStatus,
  getMachinesByCompany,
  updateMachinePaymentMode,
  getPaymentModeCapabilities
};
