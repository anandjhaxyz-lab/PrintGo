const crypto = require('crypto');
const prisma = require('../../utils/prisma');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const AppError = require('../../utils/AppError');

const DUMMY_HASH = '$2b$10$wT0o3q6/5O5k2P3V2u/9xe9B9m3XwB2Y.QJ9Q6i.YF9E2q.kL0gWy';

const signToken = (id, tokenVersion = 0) => {
  return jwt.sign({ id, tokenVersion }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '90d'
  });
};

const login = async (email, password) => {
  if (!email || !password) {
    throw new AppError('Please provide email and password', 400);
  }

  const user = await prisma.user.findUnique({
    where: { email },
    include: { company: true }
  });

  if (!user) {
    // Constant-time mitigation against timing attacks for nonexistent users
    await bcrypt.compare(password, DUMMY_HASH);
    throw new AppError('Incorrect email or password', 401);
  }

  const isPasswordCorrect = await bcrypt.compare(password, user.password);
  if (!isPasswordCorrect) {
    throw new AppError('Incorrect email or password', 401);
  }

  if (user.isActive === false) {
    throw new AppError('Your account has been deactivated. Please contact support.', 401);
  }

  if (user.activationTokenHash !== null) {
    throw new AppError('Account activation pending. Please use your activation link to set your password.', 401);
  }

  const token = signToken(user.id, user.tokenVersion);
  return { user, token };
};

const activateAccount = async (rawToken, newPassword) => {
  if (!rawToken || !newPassword) {
    throw new AppError('Activation token and new password are required', 400);
  }

  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const salt = await bcrypt.genSalt(12);
  const hashedPassword = await bcrypt.hash(newPassword, salt);

  // Single-use atomic conditional update
  const updatedUsers = await prisma.$queryRaw`
    UPDATE "User"
    SET "password" = ${hashedPassword},
        "activationTokenHash" = NULL,
        "activationExpiresAt" = NULL,
        "passwordChangedAt" = NOW(),
        "tokenVersion" = "tokenVersion" + 1,
        "updatedAt" = NOW()
    WHERE "activationTokenHash" = ${tokenHash}
      AND "activationExpiresAt" > NOW()
      AND "isActive" = true
    RETURNING "id"
  `;

  if (!updatedUsers || updatedUsers.length !== 1) {
    throw new AppError('Invalid, expired, or already used activation token', 400);
  }

  const activatedUser = await prisma.user.findUnique({
    where: { id: updatedUsers[0].id },
    include: { company: true }
  });

  const token = signToken(activatedUser.id, activatedUser.tokenVersion);
  return { user: activatedUser, token };
};

const getMe = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { company: true }
  });
  if (!user) throw new AppError('User not found', 404);
  return user;
};

module.exports = {
  signToken,
  login,
  activateAccount,
  getMe
};
