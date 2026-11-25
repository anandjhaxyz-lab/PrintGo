/**
 * PRINTGO — WP-1: DPAPI Journal Secret Engine Test Suite
 *
 * Covers:
 * 1. 32-byte cryptographically secure secret generation.
 * 2. Deterministic secondary entropy derivation from machineKey and installationId.
 * 3. Unit tests (mocked provider):
 *    - SID mismatch rejection (DPAPI_SECURITY_CONTEXT_MISMATCH).
 *    - Corrupt protected blob rejection.
 *    - Missing secret fail-closed behavior (SECRET_FILE_MISSING).
 *    - No silent secret regeneration on load.
 *    - Invalid secret length rejection.
 *    - Missing installation marker rejection.
 * 4. Real Windows Native Integration tests (real DPAPI & icacls on DESKTOP-QB6Q3BC):
 *    - Real DPAPI CurrentUser protect/unprotect roundtrip.
 *    - Real file persistence with strict NTFS ACL lockdown.
 *    - Real loadSecret roundtrip under the active Windows SID.
 * 5. Cross-account isolation:
 *    - Documented as NOT RUN (only Lenovo is enabled; other accounts disabled).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {
  JournalSecretError,
  getCurrentWindowsSid,
  deriveEntropy,
  generateSecretBytes,
  protectSecret,
  unprotectSecret,
  saveProtectedSecret,
  provisionSecret,
  loadSecret
} = require('../src/journalSecret');

describe('WP-1: Journal Secret Engine — Core & Unit Specification', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp1-secret-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  test('1. Generates exactly 32 cryptographically secure random bytes', () => {
    const s1 = generateSecretBytes();
    const s2 = generateSecretBytes();

    expect(Buffer.isBuffer(s1)).toBe(true);
    expect(s1.length).toBe(32);
    expect(Buffer.isBuffer(s2)).toBe(true);
    expect(s2.length).toBe(32);
    expect(s1.equals(s2)).toBe(false);
  });

  test('2. Derives deterministic secondary entropy using SHA-256', () => {
    const machineKey = 'mach_key_prod_1';
    const installationId = '7036e135-1c82-4e0a-ba6a-3edef7ddb90c';

    const e1 = deriveEntropy(machineKey, installationId);
    const e2 = deriveEntropy(machineKey, installationId);
    const eDifferent = deriveEntropy('other_key', installationId);

    expect(Buffer.isBuffer(e1)).toBe(true);
    expect(e1.length).toBe(32);
    expect(e1.equals(e2)).toBe(true);
    expect(e1.equals(eDifferent)).toBe(false);
  });

  test('3. Rejects invalid entropy input (missing installationId)', () => {
    expect(() => deriveEntropy('key', null)).toThrow(JournalSecretError);
    expect(() => deriveEntropy('key', '')).toThrow(JournalSecretError);
    expect(() => deriveEntropy('key', '   ')).toThrow(JournalSecretError);
  });

  test('3A. Strict deriveEntropy validation: Rejects missing, empty, whitespace-only, and non-string machineKey with MISSING_MACHINE_KEY', () => {
    const validInst = '7036e135-1c82-4e0a-ba6a-3edef7ddb90c';

    // 1. undefined
    expect(() => deriveEntropy(undefined, validInst)).toThrow(
      expect.objectContaining({ code: 'MISSING_MACHINE_KEY' })
    );

    // 2. null
    expect(() => deriveEntropy(null, validInst)).toThrow(
      expect.objectContaining({ code: 'MISSING_MACHINE_KEY' })
    );

    // 3. empty string ''
    expect(() => deriveEntropy('', validInst)).toThrow(
      expect.objectContaining({ code: 'MISSING_MACHINE_KEY' })
    );

    // 4. whitespace-only string
    expect(() => deriveEntropy('   ', validInst)).toThrow(
      expect.objectContaining({ code: 'MISSING_MACHINE_KEY' })
    );
    expect(() => deriveEntropy('\t\r\n', validInst)).toThrow(
      expect.objectContaining({ code: 'MISSING_MACHINE_KEY' })
    );

    // 5. non-string inputs
    expect(() => deriveEntropy(12345, validInst)).toThrow(
      expect.objectContaining({ code: 'MISSING_MACHINE_KEY' })
    );
    expect(() => deriveEntropy(true, validInst)).toThrow(
      expect.objectContaining({ code: 'MISSING_MACHINE_KEY' })
    );
    expect(() => deriveEntropy({}, validInst)).toThrow(
      expect.objectContaining({ code: 'MISSING_MACHINE_KEY' })
    );
    expect(() => deriveEntropy(['key'], validInst)).toThrow(
      expect.objectContaining({ code: 'MISSING_MACHINE_KEY' })
    );

    // 6. Valid trimmed string succeeds
    const eTrimmed = deriveEntropy('  valid-key  ', `  ${validInst}  `);
    const eExact = deriveEntropy('valid-key', validInst);
    expect(Buffer.isBuffer(eTrimmed)).toBe(true);
    expect(eTrimmed.length).toBe(32);
    expect(eTrimmed.equals(eExact)).toBe(true);
  });

  test('4. Unit (Mocked DPAPI): Protect and unprotect roundtrip returns exact original bytes', () => {
    // Mock DPAPI provider simulating symmetric XOR cipher with entropy
    const mockProvider = {
      protect: (plain, entropy) => {
        const out = Buffer.alloc(plain.length);
        for (let i = 0; i < plain.length; i++) {
          out[i] = plain[i] ^ entropy[i % entropy.length] ^ 0x42;
        }
        return out;
      },
      unprotect: (enc, entropy) => {
        const out = Buffer.alloc(enc.length);
        for (let i = 0; i < enc.length; i++) {
          out[i] = enc[i] ^ 0x42 ^ entropy[i % entropy.length];
        }
        return out;
      }
    };

    const secret = crypto.randomBytes(32);
    const entropy = deriveEntropy('key1', 'inst-uuid-1');

    const protectedBlob = protectSecret(secret, entropy, { dpapiProvider: mockProvider });
    expect(protectedBlob.equals(secret)).toBe(false);

    const decrypted = unprotectSecret(protectedBlob, entropy, { dpapiProvider: mockProvider });
    expect(decrypted.equals(secret)).toBe(true);
  });

  test('5. Unit (Mocked DPAPI): Rejects corrupt or truncated protected blob', () => {
    const mockProvider = {
      unprotect: () => Buffer.alloc(16) // returns truncated 16 bytes instead of 32
    };

    const entropy = deriveEntropy('key1', 'inst-uuid-1');
    expect(() => unprotectSecret(Buffer.alloc(20), entropy, { dpapiProvider: mockProvider })).toThrow(JournalSecretError);
    expect(() => unprotectSecret(Buffer.alloc(20), entropy, { dpapiProvider: mockProvider })).toThrow(
      expect.objectContaining({ code: 'INVALID_SECRET_LENGTH' })
    );
  });

  test('6. Fail-Closed: loadSecret throws SECRET_FILE_MISSING when secret file is absent', () => {
    const secretPath = path.join(tempDir, '.journal_secret');
    const markerPath = path.join(tempDir, '.installation_marker');

    fs.writeFileSync(markerPath, JSON.stringify({
      installationId: 'test-uuid',
      securityContext: { userSid: 'S-1-5-21-12345' }
    }));

    expect(fs.existsSync(secretPath)).toBe(false);
    expect(() => loadSecret({ secretPath, markerPath, machineKey: 'mach_key_unit_test' })).toThrow(JournalSecretError);
    expect(() => loadSecret({ secretPath, markerPath, machineKey: 'mach_key_unit_test' })).toThrow(
      expect.objectContaining({ code: 'SECRET_FILE_MISSING' })
    );
  });

  test('7. Fail-Closed: loadSecret strictly rejects Windows SID mismatch with DPAPI_SECURITY_CONTEXT_MISMATCH', () => {
    const secretPath = path.join(tempDir, '.journal_secret');
    const markerPath = path.join(tempDir, '.installation_marker');

    // Create marker with a different user SID
    fs.writeFileSync(markerPath, JSON.stringify({
      installationId: 'test-uuid',
      securityContext: { userSid: 'S-1-5-21-ORIGINAL-PROVISIONED-SID-9999' }
    }));

    // Create a dummy secret file
    fs.writeFileSync(secretPath, Buffer.from('some-mock-protected-blob'));

    // Attempt load with current process SID (simulated as mismatched)
    const options = {
      secretPath,
      markerPath,
      machineKey: 'mach_key_unit_test',
      currentSid: 'S-1-5-21-DIFFERENT-ACCOUNT-SID-1111'
    };

    expect(() => loadSecret(options)).toThrow(JournalSecretError);
    expect(() => loadSecret(options)).toThrow(
      expect.objectContaining({ code: 'DPAPI_SECURITY_CONTEXT_MISMATCH' })
    );
  });

  test('8. Fail-Closed: loadSecret rejects corrupted installation marker or missing securityContext', () => {
    const secretPath = path.join(tempDir, '.journal_secret');
    const markerPath = path.join(tempDir, '.installation_marker');

    fs.writeFileSync(secretPath, Buffer.from('some-mock-protected-blob'));

    // Corrupt JSON in marker
    fs.writeFileSync(markerPath, '{ not valid json');
    expect(() => loadSecret({ secretPath, markerPath, machineKey: 'mach_key_unit_test' })).toThrow(
      expect.objectContaining({ code: 'CORRUPT_INSTALLATION_MARKER' })
    );

    // Marker missing securityContext
    fs.writeFileSync(markerPath, JSON.stringify({ installationId: 'inst-1' }));
    expect(() => loadSecret({ secretPath, markerPath, machineKey: 'mach_key_unit_test' })).toThrow(
      expect.objectContaining({ code: 'MISSING_SECURITY_CONTEXT' })
    );
  });

  test('9. Provisioning never silently overwrites an existing secret without forceReprovision', () => {
    const secretPath = path.join(tempDir, '.journal_secret');
    fs.writeFileSync(secretPath, Buffer.from('existing-secret'));

    expect(() => provisionSecret({
      secretPath,
      installationId: 'test-uuid-1',
      machineKey: 'mach_key_prod_test',
      forceReprovision: false
    })).toThrow(expect.objectContaining({ code: 'SECRET_ALREADY_EXISTS' }));
  });

  test('9A. Provisioning enforcement: Rejects missing, empty, and whitespace-only machineKey without creating files', () => {
    const dataSubDir = path.join(tempDir, 'data');
    fs.mkdirSync(dataSubDir, { recursive: true });
    const secretPath = path.join(dataSubDir, '.journal_secret');
    const origEnvKey = process.env.MACHINE_KEY;
    delete process.env.MACHINE_KEY;

    try {
      // 1. undefined key
      expect(() => provisionSecret({
        secretPath,
        installationId: 'test-inst-1',
        machineKey: undefined
      })).toThrow(expect.objectContaining({ code: 'MISSING_MACHINE_KEY' }));

      // 2. empty string key
      expect(() => provisionSecret({
        secretPath,
        installationId: 'test-inst-1',
        machineKey: ''
      })).toThrow(expect.objectContaining({ code: 'MISSING_MACHINE_KEY' }));

      // 3. whitespace-only key
      expect(() => provisionSecret({
        secretPath,
        installationId: 'test-inst-1',
        machineKey: '   \t  '
      })).toThrow(expect.objectContaining({ code: 'MISSING_MACHINE_KEY' }));

      // 4. Verify no files were created in data directory
      expect(fs.existsSync(secretPath)).toBe(false);
      const remainingFiles = fs.readdirSync(dataSubDir);
      expect(remainingFiles.filter(f => f.startsWith('.journal_secret'))).toHaveLength(0);
    } finally {
      if (origEnvKey !== undefined) process.env.MACHINE_KEY = origEnvKey;
    }
  });

  test('9B. Runtime loading enforcement: Rejects missing, empty, and whitespace-only machineKey', () => {
    const secretPath = path.join(tempDir, '.journal_secret');
    const markerPath = path.join(tempDir, '.installation_marker');
    const origEnvKey = process.env.MACHINE_KEY;
    delete process.env.MACHINE_KEY;

    // Write a dummy secret file and valid marker
    fs.writeFileSync(secretPath, Buffer.from('some-protected-blob-bytes'));
    fs.writeFileSync(markerPath, JSON.stringify({
      installationId: 'test-uuid-9b',
      securityContext: { userSid: 'S-1-5-21-TEST-SID' }
    }));

    try {
      // 1. undefined key
      expect(() => loadSecret({
        secretPath,
        markerPath,
        currentSid: 'S-1-5-21-TEST-SID',
        machineKey: undefined
      })).toThrow(expect.objectContaining({ code: 'MISSING_MACHINE_KEY' }));

      // 2. empty string key
      expect(() => loadSecret({
        secretPath,
        markerPath,
        currentSid: 'S-1-5-21-TEST-SID',
        machineKey: ''
      })).toThrow(expect.objectContaining({ code: 'MISSING_MACHINE_KEY' }));

      // 3. whitespace-only key
      expect(() => loadSecret({
        secretPath,
        markerPath,
        currentSid: 'S-1-5-21-TEST-SID',
        machineKey: '   '
      })).toThrow(expect.objectContaining({ code: 'MISSING_MACHINE_KEY' }));

      // 4. Verify secret file was NOT altered or deleted
      expect(fs.existsSync(secretPath)).toBe(true);
      expect(fs.readFileSync(secretPath).toString()).toBe('some-protected-blob-bytes');
    } finally {
      if (origEnvKey !== undefined) process.env.MACHINE_KEY = origEnvKey;
    }
  });
});

const isWin = process.platform === 'win32';
const describeWindows = isWin ? describe : describe.skip;

describeWindows('WP-1: Windows Native DPAPI & NTFS ACL Integration', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp1-win-integration-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  test('10. Native Windows DPAPI CurrentUser protect/unprotect roundtrip succeeds', () => {
    const plainSecret = generateSecretBytes();
    const entropy = deriveEntropy('mach_key_prod', 'inst-win-uuid-1234');

    const protectedBlob = protectSecret(plainSecret, entropy);
    expect(Buffer.isBuffer(protectedBlob)).toBe(true);
    expect(protectedBlob.length).toBeGreaterThan(plainSecret.length); // DPAPI envelope overhead

    const decrypted = unprotectSecret(protectedBlob, entropy);
    expect(Buffer.isBuffer(decrypted)).toBe(true);
    expect(decrypted.length).toBe(32);
    expect(decrypted.equals(plainSecret)).toBe(true);
  });

  test('11. Native Windows DPAPI unprotect rejects wrong secondary entropy', () => {
    const plainSecret = generateSecretBytes();
    const entropyA = deriveEntropy('mach_key_prod', 'inst-uuid-A');
    const entropyB = deriveEntropy('mach_key_prod', 'inst-uuid-B');

    const protectedBlob = protectSecret(plainSecret, entropyA);

    expect(() => unprotectSecret(protectedBlob, entropyB)).toThrow(JournalSecretError);
    expect(() => unprotectSecret(protectedBlob, entropyB)).toThrow(
      expect.objectContaining({ code: 'DPAPI_DECRYPTION_FAILED' })
    );
  });

  test('12. Native Provisioning and Loading roundtrip with real DPAPI under current Windows SID', () => {
    const secretPath = path.join(tempDir, '.journal_secret');
    const markerPath = path.join(tempDir, '.installation_marker');
    const installationId = crypto.randomUUID();
    const machineKey = 'machine_key_noida_pilot';

    const currentSid = getCurrentWindowsSid();
    expect(currentSid).toMatch(/^S-\d-\d+(-\d+)+$/);

    // 1. Provision secret
    const provResult = provisionSecret({
      secretPath,
      installationId,
      machineKey,
      currentSid
    });

    expect(provResult.success).toBe(true);
    expect(fs.existsSync(secretPath)).toBe(true);

    // Write installation marker with recorded security context
    fs.writeFileSync(markerPath, JSON.stringify({
      installationId,
      provisionedAt: new Date().toISOString(),
      schemaVersion: 1,
      securityContext: {
        userSid: currentSid,
        userName: process.env.USERNAME
      }
    }, null, 2));

    // 2. Load secret back
    const loadedSecret = loadSecret({
      secretPath,
      markerPath,
      machineKey
    });

    expect(Buffer.isBuffer(loadedSecret)).toBe(true);
    expect(loadedSecret.length).toBe(32);
  });

  test('13. NTFS ACL verification on secret file confirms restricted access to current user and SYSTEM', () => {
    const secretPath = path.join(tempDir, '.journal_secret');
    fs.writeFileSync(secretPath, Buffer.from('test-secret-payload'));

    const res = require('../src/journalSecret').applyStrictAcl(secretPath);
    expect(res.success).toBe(true);

    const cp = require('child_process');
    const aclOut = cp.execFileSync('icacls.exe', [secretPath], { encoding: 'utf8' });

    expect(aclOut).toContain(process.env.USERNAME);
    expect(aclOut).toContain('SYSTEM');
    expect(aclOut).not.toContain('Everyone');
    expect(aclOut).not.toContain('BUILTIN\\Users');
  });

  test.skip('14. Cross-account DPAPI isolation test [NOT RUN: Single enabled account on host]', () => {
    // NOT RUN: Host DESKTOP-QB6Q3BC contains only one enabled local account ('Lenovo').
    // Other accounts (Administrator, Guest, WDAGUtilityAccount) are disabled.
    // Changing account passwords or enabling accounts is explicitly prohibited.
  });
});

describe('WP-1: End-to-End Integration (Provisioning, Journal, and Dispatch Gate)', () => {
  let tempDir;
  const JobJournal = require('../src/journal');
  const { runProvisioning } = require('../src/provision');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp1-e2e-integration-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  test('15. Fresh provisioning produces valid secret, marker with userSid, and initialized journal', () => {
    const dataDir = path.join(tempDir, 'data');
    const journalPath = path.join(dataDir, 'jobs.journal.json');
    const markerPath = path.join(dataDir, '.installation_marker');
    const secretPath = path.join(dataDir, '.journal_secret');
    const keysDir = path.join(tempDir, 'keys');

    const result = runProvisioning({
      dataDir,
      journalPath,
      markerPath,
      secretPath,
      keysDir,
      checkKeys: false,
      machineKey: 'mach-key-test-123'
    });

    expect(result.success).toBe(true);
    expect(result.code).toBe('FRESH_PROVISIONED');
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(secretPath)).toBe(true);

    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(marker.installationId).toBeTruthy();
    expect(marker.securityContext).toBeDefined();
    if (process.platform === 'win32') {
      expect(marker.securityContext.userSid).toMatch(/^S-\d-\d+(-\d+)+$/);
      expect(marker.securityContext.userName).toBe(process.env.USERNAME);
    }

    // Now instantiate JobJournal in runtime mode on this freshly provisioned directory
    const runtimeJournal = new JobJournal(journalPath, {
      markerPath,
      secretPath,
      checkKeys: false,
      checkSecret: true,
      machineKey: 'mach-key-test-123'
    });

    expect(runtimeJournal.isCorrupted).toBe(false);
    expect(runtimeJournal.corruptionReason).toBeNull();
    if (process.platform === 'win32') {
      expect(Buffer.isBuffer(runtimeJournal.secret)).toBe(true);
      expect(runtimeJournal.secret.length).toBe(32);
    }
  });

  test('16. Runtime startup fails closed if secret file is removed', () => {
    const dataDir = path.join(tempDir, 'data');
    const journalPath = path.join(dataDir, 'jobs.journal.json');
    const markerPath = path.join(dataDir, '.installation_marker');
    const secretPath = path.join(dataDir, '.journal_secret');

    runProvisioning({
      dataDir,
      journalPath,
      markerPath,
      secretPath,
      checkKeys: false,
      machineKey: 'mach-key-test-123'
    });

    // Delete the secret file
    fs.unlinkSync(secretPath);

    const runtimeJournal = new JobJournal(journalPath, {
      markerPath,
      secretPath,
      checkKeys: false,
      checkSecret: true,
      machineKey: 'mach-key-test-123'
    });

    expect(runtimeJournal.isCorrupted).toBe(true);
    expect(runtimeJournal.secret).toBeNull();
    expect(runtimeJournal.corruptionReason).toContain('Journal secret verification failed');
  });

  test('17. Runtime startup fails closed if secret blob is corrupted', () => {
    const dataDir = path.join(tempDir, 'data');
    const journalPath = path.join(dataDir, 'jobs.journal.json');
    const markerPath = path.join(dataDir, '.installation_marker');
    const secretPath = path.join(dataDir, '.journal_secret');

    runProvisioning({
      dataDir,
      journalPath,
      markerPath,
      secretPath,
      checkKeys: false,
      machineKey: 'mach-key-test-123'
    });

    // Overwrite secret with corrupted bytes
    fs.writeFileSync(secretPath, Buffer.from('corrupted-garbage-bytes-1234567890'));

    const runtimeJournal = new JobJournal(journalPath, {
      markerPath,
      secretPath,
      checkKeys: false,
      checkSecret: true,
      machineKey: 'mach-key-test-123'
    });

    expect(runtimeJournal.isCorrupted).toBe(true);
    expect(runtimeJournal.secret).toBeNull();
    expect(runtimeJournal.corruptionReason).toContain('Journal secret verification failed');
  });

  test('18. Runtime startup fails closed on SID mismatch in marker', () => {
    const dataDir = path.join(tempDir, 'data');
    const journalPath = path.join(dataDir, 'jobs.journal.json');
    const markerPath = path.join(dataDir, '.installation_marker');
    const secretPath = path.join(dataDir, '.journal_secret');

    runProvisioning({
      dataDir,
      journalPath,
      markerPath,
      secretPath,
      checkKeys: false,
      machineKey: 'mach-key-test-123'
    });

    // Modify marker SID to represent a different Windows user account
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    marker.securityContext.userSid = 'S-1-5-21-9999999999-9999999999-9999999999-9999';
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));

    const runtimeJournal = new JobJournal(journalPath, {
      markerPath,
      secretPath,
      checkKeys: false,
      checkSecret: true,
      machineKey: 'mach-key-test-123'
    });

    expect(runtimeJournal.isCorrupted).toBe(true);
    expect(runtimeJournal.secret).toBeNull();
    expect(runtimeJournal.corruptionReason).toContain('DPAPI_SECURITY_CONTEXT_MISMATCH');
  });

  test('19. Legacy journal without installation marker fails closed without silent backfill', () => {
    const dataDir = path.join(tempDir, 'data');
    const journalPath = path.join(dataDir, 'jobs.journal.json');
    const markerPath = path.join(dataDir, '.installation_marker');
    const secretPath = path.join(dataDir, '.journal_secret');

    fs.mkdirSync(dataDir, { recursive: true });
    // Write legacy journal
    fs.writeFileSync(journalPath, JSON.stringify({
      version: 2,
      jobs: {
        'job-1': { jobId: 'job-1', state: 'COMPLETED' }
      }
    }, null, 2));

    const runtimeJournal = new JobJournal(journalPath, {
      markerPath,
      secretPath,
      checkKeys: false
    });

    // Must fail closed because marker is missing
    expect(runtimeJournal.isCorrupted).toBe(true);
    expect(runtimeJournal.corruptionReason).toContain('Existing journal detected but installation marker is missing');
    // Must NOT have silently created the marker!
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  test('20. runProvisioning upfront missing machineKey validation: rejects missing/whitespace key with 0 files created', () => {
    const dataDir = path.join(tempDir, 'data-no-key');
    const journalPath = path.join(dataDir, 'jobs.journal.json');
    const markerPath = path.join(dataDir, '.installation_marker');
    const secretPath = path.join(dataDir, '.journal_secret');
    const origEnvKey = process.env.MACHINE_KEY;
    delete process.env.MACHINE_KEY;

    try {
      // 1. Missing machineKey
      const res1 = runProvisioning({
        dataDir,
        journalPath,
        markerPath,
        secretPath,
        checkKeys: false,
        machineKey: undefined
      });

      expect(res1.success).toBe(false);
      expect(res1.code).toBe('MISSING_MACHINE_KEY');
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.existsSync(secretPath)).toBe(false);
      expect(fs.existsSync(journalPath)).toBe(false);

      // 2. Whitespace-only machineKey
      const res2 = runProvisioning({
        dataDir,
        journalPath,
        markerPath,
        secretPath,
        checkKeys: false,
        machineKey: '   \t  '
      });

      expect(res2.success).toBe(false);
      expect(res2.code).toBe('MISSING_MACHINE_KEY');
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.existsSync(secretPath)).toBe(false);
      expect(fs.existsSync(journalPath)).toBe(false);
    } finally {
      if (origEnvKey !== undefined) process.env.MACHINE_KEY = origEnvKey;
    }
  });

  test('21. Runtime JobJournal startup fails closed when machineKey is missing or empty, locking out physical dispatch', () => {
    const dataDir = path.join(tempDir, 'data-missing-key-runtime');
    const journalPath = path.join(dataDir, 'jobs.journal.json');
    const markerPath = path.join(dataDir, '.installation_marker');
    const secretPath = path.join(dataDir, '.journal_secret');

    // First provision successfully with a valid key
    const provRes = runProvisioning({
      dataDir,
      journalPath,
      markerPath,
      secretPath,
      checkKeys: false,
      machineKey: 'valid-provision-key-123'
    });
    expect(provRes.success).toBe(true);

    const origEnvKey = process.env.MACHINE_KEY;
    delete process.env.MACHINE_KEY;

    try {
      // Attempt runtime startup without passing machineKey and with process.env.MACHINE_KEY unset
      const runtimeJournal = new JobJournal(journalPath, {
        markerPath,
        secretPath,
        checkKeys: false,
        checkSecret: true,
        machineKey: undefined
      });

      // Must fail closed with MISSING_MACHINE_KEY
      expect(runtimeJournal.isCorrupted).toBe(true);
      expect(runtimeJournal.secret).toBeNull();
      expect(runtimeJournal.corruptionReason).toContain('MISSING_MACHINE_KEY');

      // Replay disposition must be AMBIGUOUS (locks out physical dispatch)
      expect(runtimeJournal.getReplayDisposition('any-job-id')).toBe('AMBIGUOUS');
    } finally {
      if (origEnvKey !== undefined) process.env.MACHINE_KEY = origEnvKey;
    }
  });
});
