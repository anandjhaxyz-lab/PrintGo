const prisma = require('../../utils/prisma');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const AppError = require('../../utils/AppError');

const getCompanies = async () => {
  return await prisma.company.findMany({
    include: { machines: true, users: true }
  });
};

const createCompany = async (data) => {
  const { name, contactPerson, email, phone } = data;

  // Check if company email already exists
  const existingCompany = await prisma.company.findUnique({
    where: { contactEmail: email }
  });
  if (existingCompany) {
    throw new AppError('Company with this email already exists', 400);
  }

  // Check if user email already exists
  const existingUser = await prisma.user.findUnique({
    where: { email }
  });
  if (existingUser) {
    throw new AppError('User with this email already exists', 400);
  }

  // Generate secure activation token and hash
  const rawToken = crypto.randomBytes(32).toString('hex');
  const activationTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const activationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24-hour expiration

  // Unusable temporary hashed password; login requires account activation
  const dummySecret = crypto.randomBytes(32).toString('hex');
  const hashedPassword = await bcrypt.hash(dummySecret, 12);

  const { company, user } = await prisma.$transaction(async (tx) => {
    const newCompany = await tx.company.create({
      data: {
        name,
        contactEmail: email,
        contactPhone: phone || null,
      }
    });

    const newUser = await tx.user.create({
      data: {
        name: contactPerson || `${name} Admin`,
        email,
        password: hashedPassword,
        role: 'FRANCHISEE',
        companyId: newCompany.id,
        isActive: true,
        tokenVersion: 0,
        activationTokenHash,
        activationExpiresAt,
      }
    });

    return { company: newCompany, user: newUser };
  });

  user.password = undefined;
  user.activationTokenHash = undefined;

  const activationUrl = `/activate#token=${rawToken}`;

  return {
    company,
    user,
    activationUrl,
    activationToken: rawToken,
    expiresAt: activationExpiresAt
  };
};

module.exports = {
  getCompanies,
  createCompany
};
