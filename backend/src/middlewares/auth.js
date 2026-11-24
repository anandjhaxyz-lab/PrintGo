const jwt = require('jsonwebtoken');
const AppError = require('../utils/AppError');
const prisma = require('../utils/prisma');

const HARD_IMMUTABLE_SUNSET_MS = 1796083200000; // 2026-12-01T00:00:00.000Z

const resolveLegacySunsetCutoff = () => {
  const envVal = process.env.LEGACY_JWT_SUNSET_UTC;
  if (!envVal || envVal.trim() === '') {
    return HARD_IMMUTABLE_SUNSET_MS;
  }
  const parsed = Number(envVal);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // Fail-closed: invalid or non-finite value immediately sunsets legacy tokens
    return 0;
  }
  // Clamped to hard ceiling so env var can never extend beyond the ceiling
  return Math.min(parsed, HARD_IMMUTABLE_SUNSET_MS);
};

const protect = async (req, res, next) => {
  try {
    let token;
    
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.jwt) {
      token = req.cookies.jwt;
    }
    
    if (!token) {
      return next(new AppError('You are not logged in! Please log in to get access.', 401));
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const currentUser = await prisma.user.findUnique({
      where: { id: decoded.id }
    });
    
    if (!currentUser) {
      return next(new AppError('The user belonging to this token does no longer exist.', 401));
    }

    if (currentUser.isActive === false) {
      return next(new AppError('Your account has been deactivated. Please contact support.', 401));
    }

    if (decoded.tokenVersion !== undefined) {
      if (decoded.tokenVersion !== currentUser.tokenVersion) {
        return next(new AppError('User recently changed password or session was invalidated. Please log in again.', 401));
      }
    } else {
      // Legacy JWT without tokenVersion claim
      if (currentUser.passwordChangedAt !== null) {
        return next(new AppError('User recently changed password or session was invalidated. Please log in again.', 401));
      }
      const effectiveSunsetMs = resolveLegacySunsetCutoff();
      if (Date.now() >= effectiveSunsetMs) {
        return next(new AppError('Legacy session has expired. Please log in again.', 401));
      }
    }
    
    req.user = currentUser;
    next();
  } catch (error) {
    next(new AppError('Invalid token or token has expired', 401));
  }
};

const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action', 403));
    }
    next();
  };
};

const protectMachine = async (req, res, next) => {
  try {
    const machineKey = req.headers['x-machine-key'];
    if (!machineKey) {
      return next(new AppError('Authentication error: Missing machine key', 401));
    }

    const machine = await prisma.machine.findUnique({ where: { machineKey } });
    if (!machine) {
      return next(new AppError('Authentication error: Invalid machine key', 401));
    }
    if (machine.status === 'SUSPENDED') {
      return next(new AppError('Authentication error: Machine is suspended', 401));
    }

    req.machine = machine;
    next();
  } catch (error) {
    next(new AppError('Machine authentication failed', 401));
  }
};

module.exports = { protect, restrictTo, protectMachine, resolveLegacySunsetCutoff, HARD_IMMUTABLE_SUNSET_MS };
