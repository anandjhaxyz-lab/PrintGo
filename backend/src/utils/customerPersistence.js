'use strict';
const {
  validateIndianPhone,
  validateEmail,
  PLACEHOLDER_PHONES
} = require('./customerContact');
async function persistCustomerForJob(tx, job, options = {}) {
  if (
    !tx?.customer?.findUnique ||
    !tx?.customer?.create ||
    !tx?.customer?.update
  ) {
    throw new Error('Customer persistence requires Prisma customer methods');
  }
  const isSandbox = options.isSandbox !== false;
  const rawPhone = options.overridePhone || job.customer?.phone || null;
  const rawEmail = options.overrideEmail || job.customer?.email || null;
  const phoneResult = validateIndianPhone(rawPhone, { isSandbox });
  const emailResult = validateEmail(rawEmail);
  const phone =
    phoneResult.valid &&
    !PLACEHOLDER_PHONES.has(phoneResult.normalized)
      ? phoneResult.normalized
      : null;
  const email = emailResult.valid
    ? rawEmail.trim().toLowerCase()
    : null;
  // Serialize customer creation for the same email.
  if (email) {
    if (typeof tx.$queryRawUnsafe !== 'function') {
      throw new Error('Customer email lock requires Prisma $queryRawUnsafe');
    }
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      `customer-email:${email}`
    );
  }
  const current = job.customer || null;
  // Existing linked customer is authoritative.
  if (current) {
    const data = {};
    if (!current.phone && phone) {
      data.phone = phone;
    }
    if (!current.email && email) {
      const owner = await tx.customer.findUnique({
        where: { email }
      });
      if (!owner || owner.id === current.id) {
        data.email = email;
      }
    }
    if (Object.keys(data).length === 0) {
      return current;
    }
    return tx.customer.update({
      where: { id: current.id },
      data
    });
  }
  if (!phone && !email) {
    return null;
  }
  let emailToSave = email;
  if (email) {
    const existing = await tx.customer.findUnique({
      where: { email }
    });
    if (existing) {
      const phoneConflicts = Boolean(
        phone && existing.phone && existing.phone !== phone
      );
      if (!phoneConflicts) {
        if (!existing.phone && phone) {
          return tx.customer.update({
            where: { id: existing.id },
            data: { phone }
          });
        }
        return existing;
      }
      // Never merge records with conflicting phone numbers.
      emailToSave = null;
    }
  }
  return tx.customer.create({
    data: {
      phone,
      email: emailToSave
    }
  });
}
module.exports = { persistCustomerForJob };
