const prisma = require('../../utils/prisma');
const crypto = require('crypto');
const AppError = require('../../utils/AppError');

const ONLINE_HEARTBEAT_WINDOW_MS = 90 * 1000; // 90 seconds

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

  return machines.map(m => ({
    ...m,
    isOnline: computeIsOnline(m)
  }));
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
  
  return {
    ...machine,
    isOnline: computeIsOnline(machine)
  };
};

const createMachine = async (data) => {
  const { name, location, companyId } = data;
  const machineKey = crypto.randomBytes(32).toString('hex');
  
  const machine = await prisma.machine.create({
    data: {
      name,
      location,
      machineKey,
      companyId,
      status: 'INACTIVE'
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

  return machines.map(m => ({
    ...m,
    isOnline: computeIsOnline(m)
  }));
};

module.exports = {
  ONLINE_HEARTBEAT_WINDOW_MS,
  computeIsOnline,
  getMachines,
  getMachineById,
  createMachine,
  updateMachineStatus,
  getMachinesByCompany
};
