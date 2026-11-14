/**
 * customerContact.js
 * Customer contact validation and resolution for Cashfree payment payloads.
 *
 * Rules:
 * - Phone must be a valid Indian 10-digit mobile number (starts with 6–9).
 * - Fake/placeholder phones are rejected in production; allowed only in sandbox/test.
 * - Email must pass basic RFC5322 format and must not be a known placeholder domain.
 * - If email is unavailable or invalid, it is OMITTED from the Cashfree payload entirely.
 * - PII is never logged — only redacted forms are logged.
 */

const logger = require('./logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Placeholder phone numbers that Cashfree production will reject. */
const PLACEHOLDER_PHONES = new Set(['9999999999', '0000000000', '1234567890']);

/** Placeholder/internal email domains that must never be sent to Cashfree. */
const PLACEHOLDER_EMAIL_DOMAINS = [
  'printgo.local',
  'example.com',
  'example.org',
  'example.net',
  'test.com',
  'test.org',
  'kiosk.local',
  'localhost',
  'invalid'
];

/** Regex: basic RFC5322 format sanity check. */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Regex: patterns that identify placeholder/kiosk-generated addresses. */
const PLACEHOLDER_EMAIL_PREFIX_REGEX = /^(kiosk_|noreply_|system_|placeholder_|fake_|test_)/i;

/** Valid Indian mobile number prefixes (first digit after stripping country code). */
const VALID_INDIAN_MOBILE_PREFIXES = new Set(['6', '7', '8', '9']);

// ---------------------------------------------------------------------------
// Phone validation
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes an Indian mobile phone number for Cashfree.
 *
 * Accepted inputs:
 *   - '9876543210'       → { valid: true, normalized: '9876543210' }
 *   - '+919876543210'    → { valid: true, normalized: '9876543210' }
 *   - '919876543210'     → { valid: true, normalized: '9876543210' }
 *
 * @param {string|null|undefined} phone - Raw phone input.
 * @param {{ isSandbox?: boolean }} opts
 * @returns {{ valid: boolean, normalized: string|null, reason: string|null }}
 */
function validateIndianPhone(phone, opts = {}) {
  const isSandbox = opts.isSandbox !== false; // default true for safety

  if (phone === null || phone === undefined || phone === '') {
    return { valid: false, normalized: null, reason: 'phone is missing' };
  }

  if (typeof phone !== 'string') {
    return { valid: false, normalized: null, reason: 'phone must be a string' };
  }

  // Strip whitespace, dashes, spaces
  let normalized = phone.trim().replace(/[\s\-()]/g, '');

  // Strip leading + and country code 91
  if (normalized.startsWith('+91')) {
    normalized = normalized.slice(3);
  } else if (normalized.startsWith('91') && normalized.length === 12) {
    normalized = normalized.slice(2);
  }

  // Must be exactly 10 digits
  if (!/^\d{10}$/.test(normalized)) {
    return { valid: false, normalized: null, reason: `phone must be 10 digits after normalization (got ${normalized.length} digits)` };
  }

  // Must start with a valid Indian mobile prefix
  if (!VALID_INDIAN_MOBILE_PREFIXES.has(normalized[0])) {
    return { valid: false, normalized: null, reason: `phone prefix '${normalized[0]}' is not a valid Indian mobile prefix (must be 6–9)` };
  }

  // Reject known placeholder numbers in production
  if (PLACEHOLDER_PHONES.has(normalized)) {
    if (!isSandbox) {
      return { valid: false, normalized: null, reason: `phone '${redactPhone(normalized)}' is a known placeholder and cannot be used in production` };
    }
    // In sandbox, allow but log a warning
    logger.warn(`[customerContact] Placeholder phone used in sandbox mode: ${redactPhone(normalized)}`);
  }

  return { valid: true, normalized, reason: null };
}

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

/**
 * Validates an email address for use in Cashfree customer_details.
 *
 * @param {string|null|undefined} email - Raw email input.
 * @returns {{ valid: boolean, reason: string|null }}
 */
function validateEmail(email) {
  if (email === null || email === undefined || email === '') {
    return { valid: false, reason: 'email is missing' };
  }

  if (typeof email !== 'string') {
    return { valid: false, reason: 'email must be a string' };
  }

  const trimmed = email.trim().toLowerCase();

  if (!EMAIL_REGEX.test(trimmed)) {
    return { valid: false, reason: 'email format is invalid' };
  }

  // Extract domain for diagnostics (non-PII)
  const domain = trimmed.split('@')[1];
  const localPart = trimmed.split('@')[0];

  // Reject known placeholder domains
  if (PLACEHOLDER_EMAIL_DOMAINS.includes(domain)) {
    return { valid: false, reason: `email domain '${domain}' is a known placeholder and cannot be used` };
  }

  // Reject placeholder local-part prefixes
  if (PLACEHOLDER_EMAIL_PREFIX_REGEX.test(localPart)) {
    return { valid: false, reason: `email local part has a placeholder prefix — not a real customer address` };
  }

  return { valid: true, reason: null };
}

// ---------------------------------------------------------------------------
// Composite resolver
// ---------------------------------------------------------------------------

/**
 * Resolves a safe customer_details object for the Cashfree payment payload.
 *
 * Priority:
 *   1. `options.overridePhone` / `options.overrideEmail` (from request body)
 *   2. `job.customer.phone` / `job.customer.email` (from DB)
 *   3. Safe fallback for sandbox, enforcement error for production
 *
 * @param {object} job - PrintJob record (may include .customer relation).
 * @param {{
 *   overridePhone?: string,
 *   overrideEmail?: string,
 *   isSandbox?: boolean
 * }} options
 * @returns {{
 *   customer_id: string,
 *   customer_phone: string,
 *   customer_name: string,
 *   customer_email?: string    // omitted if no valid email is available
 * }}
 * @throws {Error} If production mode and no valid phone is available.
 */
function resolveCustomerDetails(job, options = {}) {
  const isSandbox = options.isSandbox !== false; // default true for safety

  // --- customer_id ---
  const customerId = job.customer?.id
    ? String(job.customer.id)
    : `cust_${job.shortId}`;

  // --- customer_name ---
  const customerName = (job.customer?.name && job.customer.name.trim())
    ? job.customer.name.trim()
    : 'PrintGo Customer';

  // --- customer_phone ---
  const rawPhone = options.overridePhone || job.customer?.phone || null;
  const phoneResult = validateIndianPhone(rawPhone, { isSandbox });

  let customerPhone;
  const phoneWasNotProvided =
    rawPhone === null ||
    rawPhone === undefined ||
    (typeof rawPhone === 'string' && rawPhone.trim() === '');
  if (phoneResult.valid) {
    customerPhone = phoneResult.normalized;
  } else if (phoneWasNotProvided && !isSandbox) {
    // Production: customer phone is optional. Do not invent or persist a phone number.
    logger.info(`[customerContact] No customer phone supplied for job ${job.shortId}; omitting customer_phone from Cashfree payload.`);
  } else if (isSandbox) {
    // Sandbox fallback retained for existing test behavior.
    logger.warn(`[customerContact] No valid customer phone available (reason: ${phoneResult.reason}). Using sandbox placeholder for job ${job.shortId}.`);
    customerPhone = '9999999999';
  } else {
    // A supplied but invalid phone must still be rejected in production.
    throw new Error(
      `Cannot create Cashfree order: invalid customer phone number (reason: ${phoneResult.reason}).`
    );
  }

  // --- customer_email (optional) ---
  const rawEmail = options.overrideEmail || job.customer?.email || null;
  const emailResult = validateEmail(rawEmail);

  const result = {
    customer_id: customerId,
    customer_name: customerName
  };
  if (customerPhone) {
    result.customer_phone = customerPhone;
  }

  if (emailResult.valid) {
    // Safe to include — it passed all checks
    result.customer_email = rawEmail.trim().toLowerCase();
  } else {
    // Omit email entirely from the payload rather than sending a fake/invalid address
    if (rawEmail) {
      // Only log if something was provided but invalid (not if truly absent)
      logger.warn(
        `[customerContact] Customer email omitted from Cashfree payload for job ${job.shortId}: ${emailResult.reason}. Domain: ${safeDomain(rawEmail)}`
      );
    }
    // No customer_email key added — Cashfree treats absent as "not provided" (optional field)
  }

  return result;
}

// ---------------------------------------------------------------------------
// Redaction helpers (non-PII logging)
// ---------------------------------------------------------------------------

/**
 * Redacts a phone number for safe logging: last 4 digits visible only.
 * e.g. '9876543210' → '******3210'
 */
function redactPhone(phone) {
  if (!phone || phone.length < 4) return '****';
  return '*'.repeat(phone.length - 4) + phone.slice(-4);
}

/**
 * Extracts only the domain part of an email for safe diagnostic logging.
 * Returns 'unknown-domain' if parsing fails.
 */
function safeDomain(email) {
  try {
    const parts = email.split('@');
    return parts.length === 2 ? parts[1].toLowerCase() : 'unknown-domain';
  } catch {
    return 'unknown-domain';
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  validateIndianPhone,
  validateEmail,
  resolveCustomerDetails,
  redactPhone,
  safeDomain,
  PLACEHOLDER_PHONES,
  PLACEHOLDER_EMAIL_DOMAINS
};
