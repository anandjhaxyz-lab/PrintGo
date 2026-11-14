/**
 * Authoritative Session and Advertisement Security Resolver
 *
 * Enforces strict security invariants:
 * 1. Only genuinely absent Authorization header (`undefined`) permits anonymous access.
 * 2. Empty, whitespace-only, malformed, non-Bearer, empty-token, or invalid headers throw HTTP 401.
 * 3. Token type must be strictly 'session'.
 * 4. Resolves the live database Session by its unique code.
 * 5. Rejects missing, expired, and completed sessions (allows only WAITING_FOR_MOBILE and CONNECTED).
 * 6. Mandatory wall-clock `expiresAt > now` verification.
 * 7. Exact null-safe machineId equality between JWT and DB Session (prevents token swapping/forging).
 * 8. Rejects inactive or suspended bound machines with HTTP 403.
 * 9. Admin JWTs are strictly rejected as session tokens (prevents privilege escalation/masquerade).
 * 10. Unbound dev sessions (`null === null`) and anonymous access are restricted strictly to GLOBAL advertisements.
 * 11. Zero public query parameter trust: client-supplied machineId is never accepted.
 */

const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const ALLOWED_SESSION_STATUSES = new Set(['WAITING_FOR_MOBILE', 'CONNECTED']);

/**
 * Resolves authoritative machine identity from session token or permanent printer QR code.
 * Fails closed on any error or security violation.
 *
 * @param {Object} options
 * @param {string|undefined} options.authHeader - Raw req.headers.authorization
 * @param {string|undefined} options.publicCode - Optional req.query.publicCode from physical flyer QR
 * @returns {Promise<{ isAnonymous: boolean, isUnbound: boolean, machine: Object|null }>}
 */
const resolveAuthoritativeSessionMachine = async ({ authHeader, publicCode } = {}) => {
  // -------------------------------------------------------------
  // PATH A: AUTHORIZATION HEADER PRESENT (Attempted Authentication)
  // -------------------------------------------------------------
  if (authHeader !== undefined) {
    if (typeof authHeader !== 'string' || authHeader.trim() === '') {
      throw new AppError('Empty or whitespace-only Authorization header is not permitted', 401);
    }

    const trimmed = authHeader.trim();
    if (!trimmed.startsWith('Bearer ') && trimmed !== 'Bearer') {
      throw new AppError('Malformed Authorization header: Expected "Bearer <token>" format', 401);
    }

    const token = trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : '';
    if (!token) {
      throw new AppError('Malformed Authorization header: Bearer token value is missing', 401);
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      throw new AppError('Invalid, tampered, or expired session token', 401);
    }

    // Token Type Invariant: Admin JWTs have { id } without type: 'session'.
    if (decoded.type !== 'session') {
      throw new AppError('Invalid token type: Expected session token', 401);
    }

    if (!decoded.sessionId || typeof decoded.sessionId !== 'string') {
      throw new AppError('Malformed session token: Missing sessionId claim', 401);
    }

    // Database lookup by unique session code
    const dbSession = await prisma.session.findUnique({
      where: { code: decoded.sessionId.trim() },
      include: { machine: true }
    });

    if (!dbSession) {
      throw new AppError('Session not found or has been purged', 401);
    }

    // Session Status Invariant: Only WAITING_FOR_MOBILE and CONNECTED are valid
    if (!ALLOWED_SESSION_STATUSES.has(dbSession.status)) {
      throw new AppError(`Session is in terminal state '${dbSession.status}' and cannot access advertisements`, 401);
    }

    // Wall-clock Expiry Invariant
    if (new Date(dbSession.expiresAt) <= new Date()) {
      throw new AppError('Session expired based on TTL. Please start a new session.', 401);
    }

    // Exact Null-Safe Equality Invariant
    const jwtMachineId = decoded.machineId ?? null;
    const dbMachineId = dbSession.machineId ?? null;

    if (jwtMachineId !== dbMachineId) {
      logger.warn(`Security alert: JWT machineId '${jwtMachineId}' does not match DB machineId '${dbMachineId}' for session ${dbSession.code}`);
      throw new AppError('Session machine binding mismatch: Potential token tampering', 401);
    }

    // Unbound Development Session (null === null)
    if (dbMachineId === null) {
      return { isAnonymous: false, isUnbound: true, machine: null };
    }

    // Bound Machine Status Invariant
    if (!dbSession.machine || dbSession.machine.status !== 'ACTIVE') {
      throw new AppError('Target printer is inactive, suspended, or under maintenance', 403);
    }

    return { isAnonymous: false, isUnbound: false, machine: dbSession.machine };
  }

  // -------------------------------------------------------------
  // PATH B: PERMANENT PRINTER QR SCAN (?publicCode=pq_...)
  // -------------------------------------------------------------
  if (publicCode && typeof publicCode === 'string' && publicCode.trim() !== '') {
    const cleanCode = publicCode.trim();
    const qr = await prisma.printerQr.findUnique({
      where: { publicCode: cleanCode },
      include: { machine: true }
    });

    if (!qr || qr.status !== 'ACTIVE') {
      throw new AppError('Printer QR is invalid, replaced, or revoked', 403);
    }

    if (!qr.machineId || !qr.machine || qr.machine.status !== 'ACTIVE') {
      throw new AppError('Target printer is inactive, suspended, or under maintenance', 403);
    }

    return { isAnonymous: false, isUnbound: false, machine: qr.machine };
  }

  // -------------------------------------------------------------
  // PATH C: GENUINELY ANONYMOUS (Zero Header, Zero Public Code)
  // -------------------------------------------------------------
  return { isAnonymous: true, isUnbound: true, machine: null };
};

module.exports = {
  resolveAuthoritativeSessionMachine,
  ALLOWED_SESSION_STATUSES
};
