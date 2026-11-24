const prisma = require('../../utils/prisma');
const AppError = require('../../utils/AppError');

const SUPERADMIN_MUTATION_LOCK_ID = 999901428571n; // 64-bit advisory lock key

const getUsers = async () => {
  const users = await prisma.user.findMany({
    include: { company: true },
    orderBy: { createdAt: 'desc' }
  });
  return users.map(u => {
    const { password, activationTokenHash, ...sanitized } = u;
    return sanitized;
  });
};

const getUserById = async (id) => {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { company: true }
  });
  if (!user) throw new AppError('User not found', 404);
  const { password, activationTokenHash, ...sanitized } = user;
  return sanitized;
};

const updateUser = async (id, data, currentUser) => {
  const { name, role, isActive, companyId } = data;

  return await prisma.$transaction(async (tx) => {
    // Acquire PostgreSQL 64-bit transaction advisory lock
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUPERADMIN_MUTATION_LOCK_ID}::bigint)`;

    const targetUser = await tx.user.findUnique({
      where: { id }
    });
    if (!targetUser) {
      throw new AppError('User not found', 404);
    }

    const wasActiveSuperadmin = targetUser.role === 'SUPERADMIN' && targetUser.isActive === true;
    const newRole = role !== undefined ? role : targetUser.role;
    const newIsActive = isActive !== undefined ? isActive : targetUser.isActive;
    const willBeActiveSuperadmin = newRole === 'SUPERADMIN' && newIsActive === true;

    if (wasActiveSuperadmin && !willBeActiveSuperadmin) {
      const remainingActiveCount = await tx.user.count({
        where: {
          role: 'SUPERADMIN',
          isActive: true,
          id: { not: targetUser.id }
        }
      });
      if (remainingActiveCount < 1) {
        throw new AppError('Cannot demote, deactivate, or delete the last active SUPERADMIN', 400);
      }
    }

    const roleChanged = role !== undefined && role !== targetUser.role;
    const activeChanged = isActive !== undefined && isActive !== targetUser.isActive;
    const shouldInvalidateSession = roleChanged || activeChanged;

    const updatePayload = {};
    if (name !== undefined) updatePayload.name = name;
    if (role !== undefined) updatePayload.role = role;
    if (isActive !== undefined) updatePayload.isActive = isActive;
    if (companyId !== undefined) updatePayload.companyId = companyId;
    if (shouldInvalidateSession) {
      updatePayload.tokenVersion = targetUser.tokenVersion + 1;
    }

    const updatedUser = await tx.user.update({
      where: { id },
      data: updatePayload,
      include: { company: true }
    });

    const { password, activationTokenHash, ...sanitized } = updatedUser;
    return sanitized;
  });
};

const toggleUserActive = async (id, isActive, currentUser) => {
  if (typeof isActive !== 'boolean') {
    throw new AppError('isActive must be a boolean', 400);
  }

  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUPERADMIN_MUTATION_LOCK_ID}::bigint)`;

    const targetUser = await tx.user.findUnique({
      where: { id }
    });
    if (!targetUser) {
      throw new AppError('User not found', 404);
    }

    const wasActiveSuperadmin = targetUser.role === 'SUPERADMIN' && targetUser.isActive === true;
    const willBeActiveSuperadmin = targetUser.role === 'SUPERADMIN' && isActive === true;

    if (wasActiveSuperadmin && !willBeActiveSuperadmin) {
      const remainingActiveCount = await tx.user.count({
        where: {
          role: 'SUPERADMIN',
          isActive: true,
          id: { not: targetUser.id }
        }
      });
      if (remainingActiveCount < 1) {
        throw new AppError('Cannot demote, deactivate, or delete the last active SUPERADMIN', 400);
      }
    }

    const activeChanged = isActive !== targetUser.isActive;
    const updatedUser = await tx.user.update({
      where: { id },
      data: {
        isActive,
        tokenVersion: activeChanged ? targetUser.tokenVersion + 1 : targetUser.tokenVersion
      },
      include: { company: true }
    });

    const { password, activationTokenHash, ...sanitized } = updatedUser;
    return sanitized;
  });
};

const deleteUser = async (id, currentUser) => {
  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUPERADMIN_MUTATION_LOCK_ID}::bigint)`;

    const targetUser = await tx.user.findUnique({
      where: { id }
    });
    if (!targetUser) {
      throw new AppError('User not found', 404);
    }

    if (targetUser.role === 'SUPERADMIN' && targetUser.isActive === true) {
      const remainingActiveCount = await tx.user.count({
        where: {
          role: 'SUPERADMIN',
          isActive: true,
          id: { not: targetUser.id }
        }
      });
      if (remainingActiveCount < 1) {
        throw new AppError('Cannot demote, deactivate, or delete the last active SUPERADMIN', 400);
      }
    }

    await tx.user.delete({
      where: { id }
    });

    return { success: true, message: 'User deleted successfully' };
  });
};

module.exports = {
  SUPERADMIN_MUTATION_LOCK_ID,
  getUsers,
  getUserById,
  updateUser,
  toggleUserActive,
  deleteUser
};
