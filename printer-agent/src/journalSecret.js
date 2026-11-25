const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

class JournalSecretError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JournalSecretError';
    this.code = code;
  }
}

let cachedCurrentSid = null;

/**
 * Retrieves the current Windows User SID.
 * Caches the result in memory for efficiency.
 */
function getCurrentWindowsSid() {
  if (cachedCurrentSid) {
    return cachedCurrentSid;
  }

  if (process.env.TEST_MOCK_SID) {
    return process.env.TEST_MOCK_SID;
  }

  if (process.platform !== 'win32') {
    return 'NON_WINDOWS_ENV';
  }

  try {
    const cmd = '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value';
    const sid = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    }).trim();

    if (!sid || !/^S-\d-\d+(-\d+)+$/.test(sid)) {
      throw new Error(`Invalid SID format received: "${sid}"`);
    }

    cachedCurrentSid = sid;
    return cachedCurrentSid;
  } catch (err) {
    throw new JournalSecretError('SID_RETRIEVAL_FAILED', `Failed to determine current Windows process SID: ${err.message}`);
  }
}

/**
 * Derives secondary entropy for DPAPI from machineKey and installationId.
 * Strictly requires both non-empty, trimmed string inputs.
 * Never silently substitutes default keys or fallback values.
 */
function deriveEntropy(machineKey, installationId) {
  if (typeof machineKey !== 'string' || machineKey.trim() === '') {
    throw new JournalSecretError('MISSING_MACHINE_KEY', 'machineKey is required, non-empty, and must be a valid string.');
  }

  if (!installationId || typeof installationId !== 'string' || installationId.trim() === '') {
    throw new JournalSecretError('INVALID_ENTROPY_INPUT', 'installationId is required and must be a non-empty string.');
  }

  const rawSeed = `${machineKey.trim()}:${installationId.trim()}`;
  return crypto.createHash('sha256').update(rawSeed, 'utf8').digest();
}

/**
 * Generates exactly 32 cryptographically secure random bytes.
 */
function generateSecretBytes() {
  return crypto.randomBytes(32);
}

/**
 * Encodes binary payload for standard input stream:
 * [4-byte UInt32BE entropy length][entropy bytes][data bytes]
 */
function encodeStdinPayload(entropyBuffer, dataBuffer) {
  const payload = Buffer.alloc(4 + entropyBuffer.length + dataBuffer.length);
  payload.writeUInt32BE(entropyBuffer.length, 0);
  entropyBuffer.copy(payload, 4);
  dataBuffer.copy(payload, 4 + entropyBuffer.length);
  return payload;
}

/**
 * Protects 32-byte secret using Windows DPAPI CurrentUser scope.
 *
 * WP-1C Hardening:
 * Plaintext secret material is transferred strictly via child-process standard input (stdin)
 * as binary bytes. No plaintext secret material is passed via command-line arguments (argv),
 * environment variables, logs, or temporary files.
 *
 * Memory limitation note:
 * Plaintext buffers in Node.js are zeroed immediately via .fill(0). However, the child
 * PowerShell process creates transient in-memory .NET byte arrays inside its private memory space
 * which are reclaimed by the .NET garbage collector when the helper process terminates.
 */
function protectSecret(plainBuffer, entropyBuffer, options = {}) {
  if (!Buffer.isBuffer(plainBuffer) || plainBuffer.length !== 32) {
    throw new JournalSecretError('INVALID_SECRET_LENGTH', 'Plaintext secret must be a Buffer of exactly 32 bytes.');
  }
  if (!Buffer.isBuffer(entropyBuffer) || entropyBuffer.length === 0) {
    throw new JournalSecretError('INVALID_ENTROPY_INPUT', 'Entropy buffer must be a non-empty Buffer.');
  }

  if (options.dpapiProvider && typeof options.dpapiProvider.protect === 'function') {
    return options.dpapiProvider.protect(plainBuffer, entropyBuffer);
  }

  if (process.platform !== 'win32') {
    throw new JournalSecretError('UNSUPPORTED_PLATFORM', 'Windows DPAPI CurrentUser is supported only on Windows platforms.');
  }

  const stdinPayload = encodeStdinPayload(entropyBuffer, plainBuffer);

  const psScript = `
    Add-Type -AssemblyName System.Security
    $stdin = [System.Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $stdin.CopyTo($ms)
    $all = $ms.ToArray()
    $ms.Dispose()

    if ($all.Length -lt 36) { exit 2 }

    $entLen = [System.Net.IPAddress]::NetworkToHostOrder([System.BitConverter]::ToInt32($all, 0))
    $entropy = New-Object byte[] $entLen
    [System.Array]::Copy($all, 4, $entropy, 0, $entLen)

    $plainLen = $all.Length - 4 - $entLen
    $plain = New-Object byte[] $plainLen
    [System.Array]::Copy($all, 4 + $entLen, $plain, 0, $plainLen)

    $enc = [System.Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [System.Array]::Clear($plain, 0, $plainLen)
    [System.Console]::OpenStandardOutput().Write($enc, 0, $enc.Length)
  `;

  try {
    const encBuffer = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      input: stdinPayload,
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });

    if (!Buffer.isBuffer(encBuffer) || encBuffer.length === 0) {
      throw new Error('DPAPI protect helper returned empty output.');
    }

    return encBuffer;
  } catch (err) {
    throw new JournalSecretError('DPAPI_ENCRYPTION_FAILED', `Windows DPAPI encryption failed: ${err.message}`);
  } finally {
    // Scrub the input payload copy
    stdinPayload.fill(0);
  }
}

/**
 * Decrypts protected secret using Windows DPAPI CurrentUser scope.
 * Transferred strictly over stdin and received as raw binary from stdout.
 */
function unprotectSecret(protectedBuffer, entropyBuffer, options = {}) {
  if (!Buffer.isBuffer(protectedBuffer) || protectedBuffer.length === 0) {
    throw new JournalSecretError('CORRUPT_SECRET_BLOB', 'Protected secret blob is missing or empty.');
  }
  if (!Buffer.isBuffer(entropyBuffer) || entropyBuffer.length === 0) {
    throw new JournalSecretError('INVALID_ENTROPY_INPUT', 'Entropy buffer must be a non-empty Buffer.');
  }

  if (options.dpapiProvider && typeof options.dpapiProvider.unprotect === 'function') {
    const dec = options.dpapiProvider.unprotect(protectedBuffer, entropyBuffer);
    if (!Buffer.isBuffer(dec) || dec.length !== 32) {
      throw new JournalSecretError('INVALID_SECRET_LENGTH', 'Decrypted secret must be exactly 32 bytes.');
    }
    return dec;
  }

  if (process.platform !== 'win32') {
    throw new JournalSecretError('UNSUPPORTED_PLATFORM', 'Windows DPAPI CurrentUser is supported only on Windows platforms.');
  }

  const stdinPayload = encodeStdinPayload(entropyBuffer, protectedBuffer);

  const psScript = `
    Add-Type -AssemblyName System.Security
    $stdin = [System.Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $stdin.CopyTo($ms)
    $all = $ms.ToArray()
    $ms.Dispose()

    if ($all.Length -le 4) { exit 2 }

    $entLen = [System.Net.IPAddress]::NetworkToHostOrder([System.BitConverter]::ToInt32($all, 0))
    $entropy = New-Object byte[] $entLen
    [System.Array]::Copy($all, 4, $entropy, 0, $entLen)

    $encLen = $all.Length - 4 - $entLen
    $enc = New-Object byte[] $encLen
    [System.Array]::Copy($all, 4 + $entLen, $enc, 0, $encLen)

    $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [System.Console]::OpenStandardOutput().Write($dec, 0, $dec.Length)
  `;

  try {
    const decBuffer = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      input: stdinPayload,
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });

    if (!Buffer.isBuffer(decBuffer) || decBuffer.length !== 32) {
      throw new JournalSecretError('INVALID_SECRET_LENGTH', `Decrypted secret has invalid length: ${decBuffer.length} (expected 32 bytes).`);
    }

    return decBuffer;
  } catch (err) {
    if (err instanceof JournalSecretError) throw err;
    throw new JournalSecretError('DPAPI_DECRYPTION_FAILED', `Windows DPAPI decryption failed (corrupted blob, wrong account, or invalid key): ${err.message}`);
  } finally {
    stdinPayload.fill(0);
  }
}

/**
 * Applies restrictive NTFS ACLs on Windows: grants R/W only to the current user and SYSTEM.
 * Strips inherited permissions.
 */
function applyStrictAcl(filePath, options = {}) {
  if (process.platform !== 'win32') {
    return { success: true, skipped: true, reason: 'NON_WINDOWS' };
  }

  const userName = options.userName || process.env.USERNAME;
  if (!userName) {
    throw new JournalSecretError('ACL_LOCKDOWN_FAILED', 'Cannot determine current username for ACL lockdown.');
  }

  try {
    // 1. Remove inheritance and grant access exclusively to current user (Modify) and SYSTEM (Full Control)
    cp.execFileSync('icacls.exe', [
      filePath,
      '/inheritance:r',
      '/grant:r',
      `${userName}:(M)`,
      '/grant:r',
      'SYSTEM:(F)'
    ], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });

    // 2. Verify ACL immediately
    const aclOut = cp.execFileSync('icacls.exe', [filePath], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });

    const hasUser = aclOut.includes(userName);
    const hasSystem = aclOut.includes('SYSTEM');
    const hasEveryone = aclOut.includes('Everyone');
    const hasUsersGroup = aclOut.includes('BUILTIN\\Users');

    if (!hasUser || !hasSystem || hasEveryone || hasUsersGroup) {
      throw new JournalSecretError('ACL_VERIFICATION_FAILED', `ACL verification failed: unexpected permissions detected in icacls output: ${aclOut}`);
    }

    return { success: true, acl: aclOut.trim() };
  } catch (err) {
    if (err instanceof JournalSecretError) throw err;
    throw new JournalSecretError('ACL_LOCKDOWN_FAILED', `Failed to apply restrictive NTFS ACL to ${filePath}: ${err.message}`);
  }
}

/**
 * Atomically saves the protected secret buffer to disk with restrictive ACLs.
 */
function saveProtectedSecret(secretPath, protectedBuffer, options = {}) {
  const dir = path.dirname(secretPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${secretPath}.tmp.${Date.now()}_${crypto.randomUUID()}`;
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'w', 0o600);
    fs.writeSync(fd, protectedBuffer, 0, protectedBuffer.length);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tempPath, secretPath);

    // Apply strict NTFS ACLs
    applyStrictAcl(secretPath, options);

    return { success: true, path: secretPath };
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
    if (err instanceof JournalSecretError) throw err;
    throw new JournalSecretError('SECRET_PERSISTENCE_FAILED', `Failed to persist protected journal secret: ${err.message}`);
  }
}

/**
 * Provisions a new 32-byte secret for the installation.
 * Never silently overwrites an existing secret unless options.forceReprovision === true.
 */
function provisionSecret(options = {}) {
  const secretPath = options.secretPath || path.join(__dirname, '../data/.journal_secret');
  const installationId = options.installationId;
  const rawMachineKey = options.machineKey !== undefined ? options.machineKey : process.env.MACHINE_KEY;
  const currentSid = options.currentSid || getCurrentWindowsSid();

  if (typeof rawMachineKey !== 'string' || rawMachineKey.trim() === '') {
    throw new JournalSecretError('MISSING_MACHINE_KEY', 'machineKey is required, non-empty, and must be a valid string.');
  }
  const machineKey = rawMachineKey.trim();

  if (!installationId || typeof installationId !== 'string' || installationId.trim() === '') {
    throw new JournalSecretError('INVALID_ENTROPY_INPUT', 'installationId is required and must be a non-empty string.');
  }

  if (fs.existsSync(secretPath) && !options.forceReprovision) {
    throw new JournalSecretError('SECRET_ALREADY_EXISTS', `Journal secret already exists at ${secretPath}. Refusing silent overwrite.`);
  }

  const plainSecret = generateSecretBytes();
  try {
    const entropy = deriveEntropy(machineKey, installationId);
    const protectedBlob = protectSecret(plainSecret, entropy, options);

    saveProtectedSecret(secretPath, protectedBlob, options);

    return {
      success: true,
      secretPath,
      userSid: currentSid,
      installationId
    };
  } finally {
    // Scrub plaintext secret buffer from memory
    plainSecret.fill(0);
  }
}

/**
 * Loads and unprotects the 32-byte journal secret from disk.
 * Strictly verifies Windows SID match before unprotecting.
 * Fail-closed on missing, corrupted, or mismatch conditions.
 */
function loadSecret(options = {}) {
  const secretPath = options.secretPath || path.join(__dirname, '../data/.journal_secret');
  const markerPath = options.markerPath || path.join(path.dirname(secretPath), '.installation_marker');
  const rawMachineKey = options.machineKey !== undefined ? options.machineKey : process.env.MACHINE_KEY;

  if (typeof rawMachineKey !== 'string' || rawMachineKey.trim() === '') {
    throw new JournalSecretError('MISSING_MACHINE_KEY', 'machineKey is required, non-empty, and must be a valid string.');
  }
  const machineKey = rawMachineKey.trim();

  // 1. Missing secret is a strict fail-closed condition
  if (!fs.existsSync(secretPath)) {
    throw new JournalSecretError('SECRET_FILE_MISSING', `Journal secret file does not exist at ${secretPath}. Normal startup cannot silently regenerate keys.`);
  }

  // 2. Read installation marker to obtain installationId and expected securityContext
  if (!fs.existsSync(markerPath)) {
    throw new JournalSecretError('INSTALLATION_MARKER_MISSING', `Installation marker missing at ${markerPath}. Cannot verify security context.`);
  }

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (err) {
    throw new JournalSecretError('CORRUPT_INSTALLATION_MARKER', `Installation marker at ${markerPath} is corrupt or unreadable: ${err.message}`);
  }

  const installationId = marker.installationId;
  if (!installationId || typeof installationId !== 'string') {
    throw new JournalSecretError('CORRUPT_INSTALLATION_MARKER', 'Installation marker does not contain a valid installationId.');
  }

  // 3. Security context SID comparison
  const expectedSid = options.expectedSid || (marker.securityContext && marker.securityContext.userSid);
  if (!expectedSid) {
    throw new JournalSecretError('MISSING_SECURITY_CONTEXT', 'Installation marker does not contain securityContext.userSid. Provisioning identity unverified.');
  }

  const currentSid = options.currentSid || getCurrentWindowsSid();
  if (currentSid !== expectedSid) {
    throw new JournalSecretError(
      'DPAPI_SECURITY_CONTEXT_MISMATCH',
      `Current Windows process SID (${currentSid}) does not match provisioning SID (${expectedSid}). Dispatches refused.`
    );
  }

  // 4. Read protected blob
  let protectedBuffer;
  try {
    protectedBuffer = fs.readFileSync(secretPath);
  } catch (err) {
    throw new JournalSecretError('SECRET_READ_FAILED', `Failed to read protected secret from ${secretPath}: ${err.message}`);
  }

  if (protectedBuffer.length === 0) {
    throw new JournalSecretError('CORRUPT_SECRET_BLOB', `Journal secret file at ${secretPath} is empty or truncated.`);
  }

  // 5. Unprotect using derived entropy
  const entropy = deriveEntropy(machineKey, installationId);
  return unprotectSecret(protectedBuffer, entropy, options);
}

module.exports = {
  JournalSecretError,
  getCurrentWindowsSid,
  deriveEntropy,
  generateSecretBytes,
  protectSecret,
  unprotectSecret,
  applyStrictAcl,
  saveProtectedSecret,
  provisionSecret,
  loadSecret
};
