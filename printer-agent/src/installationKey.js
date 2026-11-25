const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const journalSecret = require('./journalSecret');

class InstallationKeyError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = 'InstallationKeyError';
    this.code = code;
  }
}

/**
 * Computes secondary entropy for the installation identity key with domain separation.
 * Derives SHA-256(machineKey + ':' + installationId + ':installation_identity_key')
 */
function deriveKeyEntropy(machineKey, installationId) {
  if (typeof machineKey !== 'string' || machineKey.trim() === '') {
    throw new InstallationKeyError('MISSING_MACHINE_KEY', 'machineKey is required, non-empty, and must be a valid string.');
  }
  if (!installationId || typeof installationId !== 'string' || installationId.trim() === '') {
    throw new InstallationKeyError('INVALID_INSTALLATION_ID', 'installationId is required and must be a non-empty string.');
  }

  const domainSeparatedId = `${installationId.trim()}:installation_identity_key`;
  return journalSecret.deriveEntropy(machineKey.trim(), domainSeparatedId);
}

/**
 * Generates an ECDSA P-256 keypair using native Node.js crypto.
 * Returns public key in standard SPKI PEM format, DER fingerprint,
 * and the 32-byte private key scalar d.
 */
function generateInstallationKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  });

  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const keyFingerprint = crypto.createHash('sha256').update(publicKeyDer).digest('hex');

  const jwk = privateKey.export({ format: 'jwk' });
  const privateKeyScalar = Buffer.from(jwk.d, 'base64url');

  if (privateKeyScalar.length !== 32) {
    privateKeyScalar.fill(0);
    throw new InstallationKeyError('INVALID_KEY_SCALAR', `ECDSA P-256 private key scalar length is ${privateKeyScalar.length}, expected 32 bytes.`);
  }

  return {
    privateKeyScalar,
    publicKeyPem,
    publicKeyDer,
    keyFingerprint,
    jwkPub: { x: jwk.x, y: jwk.y }
  };
}

/**
 * Reconstructs a Node.js crypto PrivateKeyObject from a 32-byte private scalar and SPKI public key PEM.
 */
function reconstructPrivateKey(privateKeyScalar, publicKeyPem) {
  if (!Buffer.isBuffer(privateKeyScalar) || privateKeyScalar.length !== 32) {
    throw new InstallationKeyError('INVALID_KEY_SCALAR', 'Private key scalar must be a Buffer of exactly 32 bytes.');
  }

  let pubKeyObj;
  try {
    pubKeyObj = crypto.createPublicKey(publicKeyPem);
  } catch (err) {
    throw new InstallationKeyError('CORRUPT_PUBLIC_KEY', `Failed to parse public key PEM: ${err.message}`);
  }

  const pubJwk = pubKeyObj.export({ format: 'jwk' });
  const privJwk = {
    kty: 'EC',
    crv: 'P-256',
    d: privateKeyScalar.toString('base64url'),
    x: pubJwk.x,
    y: pubJwk.y
  };

  try {
    return crypto.createPrivateKey({ key: privJwk, format: 'jwk' });
  } catch (err) {
    throw new InstallationKeyError('RECONSTRUCTION_FAILED', `Failed to reconstruct private key object: ${err.message}`);
  }
}

/**
 * Validates cryptographic consistency of a public/private keypair by signing and verifying a probe payload.
 */
function validateKeyPair(privateKeyObj, publicKeyPem) {
  const probe = Buffer.from(`KEYPAIR_PROBE_${crypto.randomUUID()}_${Date.now()}`);
  let sig;
  try {
    sig = crypto.sign('sha256', probe, privateKeyObj);
  } catch (err) {
    throw new InstallationKeyError('KEYPAIR_SIGN_FAILED', `Failed to sign validation probe: ${err.message}`);
  }

  let pubKeyObj;
  try {
    pubKeyObj = crypto.createPublicKey(publicKeyPem);
  } catch (err) {
    throw new InstallationKeyError('CORRUPT_PUBLIC_KEY', `Failed to parse public key for validation: ${err.message}`);
  }

  const isValid = crypto.verify('sha256', probe, pubKeyObj, sig);
  if (!isValid) {
    throw new InstallationKeyError('KEYPAIR_MISMATCH', 'Public and private key do not form a mathematically valid keypair.');
  }

  return true;
}

/**
 * Provisions an asymmetric installation identity keypair.
 * Encrypts private key using DPAPI CurrentUser scope and saves with restrictive NTFS ACLs.
 * Public key is written in standard SPKI PEM format.
 * Fails closed if keys already exist unless options.forceReprovision === true.
 */
function provisionInstallationKey(options = {}) {
  const keyDir = options.keyDir || path.join(__dirname, '../data');
  const privateKeyPath = options.privateKeyPath || path.join(keyDir, '.installation_key.enc');
  const publicKeyPath = options.publicKeyPath || path.join(keyDir, 'installation_key.pub');
  const markerPath = options.markerPath || path.join(keyDir, '.installation_marker');

  const rawMachineKey = options.machineKey !== undefined ? options.machineKey : process.env.MACHINE_KEY;
  if (typeof rawMachineKey !== 'string' || rawMachineKey.trim() === '') {
    throw new InstallationKeyError('MISSING_MACHINE_KEY', 'machineKey is required, non-empty, and must be configured.');
  }
  const machineKey = rawMachineKey.trim();

  const installationId = options.installationId;
  if (!installationId || typeof installationId !== 'string' || installationId.trim() === '') {
    throw new InstallationKeyError('INVALID_INSTALLATION_ID', 'installationId is required and must be a non-empty string.');
  }

  if ((fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath)) && !options.forceReprovision) {
    throw new InstallationKeyError('KEY_ALREADY_EXISTS', `Installation identity key already exists at ${privateKeyPath}. Refusing silent overwrite.`);
  }

  if (!fs.existsSync(keyDir)) {
    fs.mkdirSync(keyDir, { recursive: true });
  }

  // 1. Generate keypair
  const { privateKeyScalar, publicKeyPem, keyFingerprint } = generateInstallationKeyPair();

  try {
    // 2. Validate keypair math before saving
    const privObj = reconstructPrivateKey(privateKeyScalar, publicKeyPem);
    validateKeyPair(privObj, publicKeyPem);

    // 3. Encrypt private key scalar via DPAPI CurrentUser
    const entropy = deriveKeyEntropy(machineKey, installationId);
    const protectedBlob = journalSecret.protectSecret(privateKeyScalar, entropy, options);

    // 4. Save protected private key atomically with restrictive ACLs
    journalSecret.saveProtectedSecret(privateKeyPath, protectedBlob, options);

    // 5. Save public key atomically
    const tempPubPath = `${publicKeyPath}.tmp.${Date.now()}_${crypto.randomUUID()}`;
    fs.writeFileSync(tempPubPath, publicKeyPem, 'utf8');
    fs.renameSync(tempPubPath, publicKeyPath);

    return {
      success: true,
      installationId: installationId.trim(),
      keyAlgorithm: 'ECDSA_P256',
      keyFormat: 'spki_pem',
      keyFingerprint,
      publicKeyPem,
      privateKeyPath,
      publicKeyPath
    };
  } finally {
    // Scrub plaintext private key scalar from memory
    privateKeyScalar.fill(0);
  }
}

/**
 * Loads the DPAPI-protected installation private key and public key from disk.
 * Enforces Windows SID verification, decrypts private key scalar, reconstructs
 * PrivateKeyObject and cryptographically validates keypair before returning.
 */
function loadInstallationKey(options = {}) {
  const keyDir = options.keyDir || path.join(__dirname, '../data');
  const privateKeyPath = options.privateKeyPath || path.join(keyDir, '.installation_key.enc');
  const publicKeyPath = options.publicKeyPath || path.join(keyDir, 'installation_key.pub');
  const markerPath = options.markerPath || path.join(keyDir, '.installation_marker');

  const rawMachineKey = options.machineKey !== undefined ? options.machineKey : process.env.MACHINE_KEY;
  if (typeof rawMachineKey !== 'string' || rawMachineKey.trim() === '') {
    throw new InstallationKeyError('MISSING_MACHINE_KEY', 'machineKey is required, non-empty, and must be configured.');
  }
  const machineKey = rawMachineKey.trim();

  // 1. Check existence of key files
  if (!fs.existsSync(privateKeyPath)) {
    throw new InstallationKeyError('PRIVATE_KEY_MISSING', `Installation private key file missing at ${privateKeyPath}.`);
  }
  if (!fs.existsSync(publicKeyPath)) {
    throw new InstallationKeyError('PUBLIC_KEY_MISSING', `Installation public key file missing at ${publicKeyPath}.`);
  }

  // 2. Read installation marker to obtain installationId and expected SID
  let installationId = options.installationId;
  let expectedSid = options.expectedSid;

  if (fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (!installationId && marker.installationId) {
        installationId = marker.installationId;
      }
      if (!expectedSid && marker.securityContext && marker.securityContext.userSid) {
        expectedSid = marker.securityContext.userSid;
      }
    } catch (err) {
      throw new InstallationKeyError('CORRUPT_INSTALLATION_MARKER', `Installation marker at ${markerPath} is corrupt: ${err.message}`);
    }
  }

  if (!installationId || typeof installationId !== 'string') {
    throw new InstallationKeyError('MISSING_INSTALLATION_ID', 'Cannot determine installationId for key loading.');
  }

  // 3. Security context SID verification
  const currentSid = options.currentSid || journalSecret.getCurrentWindowsSid();
  if (expectedSid && currentSid !== expectedSid) {
    throw new InstallationKeyError(
      'DPAPI_SECURITY_CONTEXT_MISMATCH',
      `Current Windows process SID (${currentSid}) does not match provisioning SID (${expectedSid}). Dispatches refused.`
    );
  }

  // 4. Read public key
  let publicKeyPem;
  try {
    publicKeyPem = fs.readFileSync(publicKeyPath, 'utf8');
  } catch (err) {
    throw new InstallationKeyError('PUBLIC_KEY_READ_FAILED', `Failed to read public key: ${err.message}`);
  }

  if (!publicKeyPem.trim().startsWith('-----BEGIN PUBLIC KEY-----')) {
    throw new InstallationKeyError('CORRUPT_PUBLIC_KEY', 'Public key file does not contain a valid SPKI PEM header.');
  }

  // 5. Read and unprotect private key scalar
  let protectedBlob;
  try {
    protectedBlob = fs.readFileSync(privateKeyPath);
  } catch (err) {
    throw new InstallationKeyError('PRIVATE_KEY_READ_FAILED', `Failed to read protected key file: ${err.message}`);
  }

  if (protectedBlob.length === 0) {
    throw new InstallationKeyError('CORRUPT_KEY_BLOB', 'Protected installation key file is empty or truncated.');
  }

  const entropy = deriveKeyEntropy(machineKey, installationId);
  const privateKeyScalar = journalSecret.unprotectSecret(protectedBlob, entropy, options);

  try {
    // 6. Reconstruct private key object
    const privateKeyObj = reconstructPrivateKey(privateKeyScalar, publicKeyPem);

    // 7. Cryptographically validate keypair integrity
    validateKeyPair(privateKeyObj, publicKeyPem);

    const pubKeyObj = crypto.createPublicKey(publicKeyPem);
    const publicKeyDer = pubKeyObj.export({ type: 'spki', format: 'der' });
    const keyFingerprint = crypto.createHash('sha256').update(publicKeyDer).digest('hex');

    return {
      privateKey: privateKeyObj,
      publicKey: pubKeyObj,
      publicKeyPem,
      keyFingerprint,
      installationId: installationId.trim(),
      keyAlgorithm: 'ECDSA_P256',
      keyFormat: 'spki_pem'
    };
  } finally {
    // Scrub plaintext scalar from memory
    privateKeyScalar.fill(0);
  }
}

/**
 * WP-2H.1: Builds unambiguous, sorted canonical JSON payload for challenge-response enrollment.
 * Guaranteed exact byte-for-byte reproducibility between Agent signer and Backend verifier.
 */
function buildCanonicalChallengePayload({
  protocolVersion = 1,
  challengeId,
  challengeNonce,
  machineId,
  installationId,
  purpose = 'INSTALLATION_KEY_ENROLLMENT',
  issuedAt,
  expiresAt
}) {
  return JSON.stringify({
    challengeId: String(challengeId),
    challengeNonce: String(challengeNonce),
    expiresAt: new Date(expiresAt).toISOString(),
    installationId: String(installationId).trim(),
    issuedAt: new Date(issuedAt).toISOString(),
    machineId: String(machineId),
    protocolVersion: Number(protocolVersion),
    purpose: String(purpose)
  });
}

/**
 * WP-2H.1: Signs a server-issued enrollment challenge using the protected ECDSA P-256 private key.
 * Strictly validates challenge expiry, machineId binding, and installationId binding.
 */
function signEnrollmentChallenge({
  privateKey,
  machineId,
  installationId,
  challenge
}) {
  if (!privateKey) {
    throw new InstallationKeyError('MISSING_PRIVATE_KEY', 'privateKey object is required to sign enrollment challenge.');
  }
  if (!machineId || typeof machineId !== 'string' || machineId.trim() === '') {
    throw new InstallationKeyError('INVALID_MACHINE_ID', 'machineId is required and must be a non-empty string.');
  }
  if (!installationId || typeof installationId !== 'string' || installationId.trim() === '') {
    throw new InstallationKeyError('INVALID_INSTALLATION_ID', 'installationId is required and must be a non-empty string.');
  }
  if (!challenge || typeof challenge !== 'object') {
    throw new InstallationKeyError('INVALID_CHALLENGE', 'Challenge object is required.');
  }

  const {
    challengeId,
    challengeNonce,
    issuedAt,
    expiresAt,
    purpose = 'INSTALLATION_KEY_ENROLLMENT',
    protocolVersion = 1,
    machineId: challengeMachineId,
    installationId: challengeInstallationId
  } = challenge;

  if (!challengeId || !challengeNonce || !issuedAt || !expiresAt) {
    throw new InstallationKeyError('MALFORMED_CHALLENGE', 'Challenge response missing mandatory fields.');
  }

  // Verify challenge bindings
  if (challengeMachineId && challengeMachineId !== machineId) {
    throw new InstallationKeyError('CHALLENGE_MACHINE_MISMATCH', 'Challenge was not issued for this machine.');
  }
  if (challengeInstallationId && challengeInstallationId.trim() !== installationId.trim()) {
    throw new InstallationKeyError('CHALLENGE_INSTALLATION_MISMATCH', 'Challenge was not issued for this installation.');
  }

  // Check expiry
  if (new Date() > new Date(expiresAt)) {
    throw new InstallationKeyError('CHALLENGE_EXPIRED', 'Server-issued challenge has expired.');
  }

  const canonicalPayload = buildCanonicalChallengePayload({
    protocolVersion,
    challengeId,
    challengeNonce,
    machineId,
    installationId: installationId.trim(),
    purpose,
    issuedAt,
    expiresAt
  });

  const sig = crypto.sign('sha256', Buffer.from(canonicalPayload, 'utf8'), privateKey);

  return {
    protocolVersion,
    challengeId,
    challengeNonce,
    signature: sig.toString('base64'),
    canonicalPayload
  };
}

/**
 * Legacy proof-of-possession generator. Permanently disabled per AUDIT-WP2H-01.
 */
function createProofOfPossession() {
  throw new InstallationKeyError(
    'DEPRECATED_PROOF_MECHANISM',
    'Client-timestamp-only proof of possession has been permanently deprecated per AUDIT-WP2H-01. Use signEnrollmentChallenge() with a server-issued challenge nonce.'
  );
}

module.exports = {
  InstallationKeyError,
  deriveKeyEntropy,
  generateInstallationKeyPair,
  reconstructPrivateKey,
  validateKeyPair,
  provisionInstallationKey,
  loadInstallationKey,
  buildCanonicalChallengePayload,
  signEnrollmentChallenge,
  createProofOfPossession
};
