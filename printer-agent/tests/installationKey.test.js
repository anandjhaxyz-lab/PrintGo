const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const installationKey = require('../src/installationKey');
const journalSecret = require('../src/journalSecret');

describe('WP-2H / Phase 15.8: Installation Asymmetric Key Lifecycle & Security', () => {
  let sandboxDir;
  let mockDpapi;

  beforeEach(() => {
    sandboxDir = path.join(os.tmpdir(), `wp2h_test_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`);
    fs.mkdirSync(sandboxDir, { recursive: true });

    // Isolated in-memory DPAPI provider for deterministic unit testing
    mockDpapi = {
      protect: jest.fn((plainBuffer, entropyBuffer) => {
        const cipher = crypto.createCipheriv('aes-256-cbc', entropyBuffer.slice(0, 32), Buffer.alloc(16, 7));
        return Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
      }),
      unprotect: jest.fn((protectedBuffer, entropyBuffer) => {
        const decipher = crypto.createDecipheriv('aes-256-cbc', entropyBuffer.slice(0, 32), Buffer.alloc(16, 7));
        return Buffer.concat([decipher.update(protectedBuffer), decipher.final()]);
      })
    };
  });

  afterEach(() => {
    if (fs.existsSync(sandboxDir)) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  test('1. Fresh installation key generation produces valid ECDSA P-256 parameters', () => {
    const keypair = installationKey.generateInstallationKeyPair();

    expect(keypair.privateKeyScalar).toBeInstanceOf(Buffer);
    expect(keypair.privateKeyScalar.length).toBe(32);
    expect(keypair.publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(keypair.publicKeyPem).toContain('-----END PUBLIC KEY-----');
    expect(typeof keypair.keyFingerprint).toBe('string');
    expect(keypair.keyFingerprint.length).toBe(64); // SHA-256 hex
  });

  test('2. Valid ECDSA P-256 signature verification over arbitrary data payload', () => {
    const keypair = installationKey.generateInstallationKeyPair();
    const privObj = installationKey.reconstructPrivateKey(keypair.privateKeyScalar, keypair.publicKeyPem);
    const pubObj = crypto.createPublicKey(keypair.publicKeyPem);

    const testPayload = Buffer.from('CRITICAL_FENCING_CHALLENGE_NONCE_2026');
    const signature = crypto.sign('sha256', testPayload, privObj);

    const isValid = crypto.verify('sha256', testPayload, pubObj, signature);
    expect(isValid).toBe(true);

    const isTampered = crypto.verify('sha256', Buffer.from('TAMPERED_CHALLENGE'), pubObj, signature);
    expect(isTampered).toBe(false);
  });

  test('3. Private key is strictly protected at rest via DPAPI and contains no plaintext PEM', () => {
    const machineKey = 'test-machine-key-12345';
    const installationId = crypto.randomUUID();

    const provResult = installationKey.provisionInstallationKey({
      keyDir: sandboxDir,
      machineKey,
      installationId,
      dpapiProvider: mockDpapi
    });

    expect(provResult.success).toBe(true);
    expect(fs.existsSync(provResult.privateKeyPath)).toBe(true);

    const encBytes = fs.readFileSync(provResult.privateKeyPath);
    // Ciphertext must NOT contain unencrypted PEM headers or plain ASCII
    expect(encBytes.toString('utf8')).not.toContain('-----BEGIN');
    expect(encBytes.toString('utf8')).not.toContain('PRIVATE KEY');
    expect(mockDpapi.protect).toHaveBeenCalledTimes(1);
  });

  test('4. Private key material is never included in challenge signature or enrollment payload', () => {
    const keypair = installationKey.generateInstallationKeyPair();
    const privObj = installationKey.reconstructPrivateKey(keypair.privateKeyScalar, keypair.publicKeyPem);

    const machineId = 'm_001';
    const installationId = crypto.randomUUID();
    const mockChallenge = {
      challengeId: crypto.randomUUID(),
      challengeNonce: crypto.randomBytes(32).toString('hex'),
      machineId,
      installationId,
      purpose: 'INSTALLATION_KEY_ENROLLMENT',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString()
    };

    const signedChallenge = installationKey.signEnrollmentChallenge({
      privateKey: privObj,
      machineId,
      installationId,
      challenge: mockChallenge
    });

    expect(signedChallenge).toHaveProperty('signature');
    expect(signedChallenge).toHaveProperty('challengeId', mockChallenge.challengeId);
    expect(signedChallenge).toHaveProperty('challengeNonce', mockChallenge.challengeNonce);
    expect(typeof signedChallenge.signature).toBe('string');

    // Ensure no private key scalar or PEM leaked into payload
    const serialized = JSON.stringify(signedChallenge);
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('scalar');
    expect(serialized).not.toContain('BEGIN EC PRIVATE');

    // Verify deprecated client-timestamp-only proof throws
    expect(() => installationKey.createProofOfPossession()).toThrow(/DEPRECATED_PROOF_MECHANISM/i);
  });

  test('4b. signEnrollmentChallenge enforces strict binding to machineId, installationId, and expiry', () => {
    const keypair = installationKey.generateInstallationKeyPair();
    const privObj = installationKey.reconstructPrivateKey(keypair.privateKeyScalar, keypair.publicKeyPem);

    const machineId = 'm_001';
    const installationId = crypto.randomUUID();
    const validChallenge = {
      challengeId: crypto.randomUUID(),
      challengeNonce: crypto.randomBytes(32).toString('hex'),
      machineId,
      installationId,
      purpose: 'INSTALLATION_KEY_ENROLLMENT',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString()
    };

    // 1. Mismatched machineId
    expect(() => {
      installationKey.signEnrollmentChallenge({
        privateKey: privObj,
        machineId: 'm_DIFFERENT',
        installationId,
        challenge: validChallenge
      });
    }).toThrow(/CHALLENGE_MACHINE_MISMATCH/i);

    // 2. Mismatched installationId
    expect(() => {
      installationKey.signEnrollmentChallenge({
        privateKey: privObj,
        machineId,
        installationId: crypto.randomUUID(),
        challenge: validChallenge
      });
    }).toThrow(/CHALLENGE_INSTALLATION_MISMATCH/i);

    // 3. Expired challenge
    const expiredChallenge = {
      ...validChallenge,
      expiresAt: new Date(Date.now() - 5000).toISOString()
    };
    expect(() => {
      installationKey.signEnrollmentChallenge({
        privateKey: privObj,
        machineId,
        installationId,
        challenge: expiredChallenge
      });
    }).toThrow(/CHALLENGE_EXPIRED/i);
  });

  test('5. Missing DPAPI capability throws explicit error without creating partial files', () => {
    const failingDpapi = {
      protect: () => { throw new Error('DPAPI_SUBSYSTEM_UNAVAILABLE'); },
      unprotect: () => {}
    };

    expect(() => {
      installationKey.provisionInstallationKey({
        keyDir: sandboxDir,
        machineKey: 'mk_test_123',
        installationId: crypto.randomUUID(),
        dpapiProvider: failingDpapi
      });
    }).toThrow();

    const privateKeyPath = path.join(sandboxDir, '.installation_key.enc');
    const publicKeyPath = path.join(sandboxDir, 'installation_key.pub');
    expect(fs.existsSync(privateKeyPath)).toBe(false);
    expect(fs.existsSync(publicKeyPath)).toBe(false);
  });

  test('6. Corrupt encrypted private key fails closed during load', () => {
    const machineKey = 'mk_valid_test_key';
    const installationId = crypto.randomUUID();

    const provResult = installationKey.provisionInstallationKey({
      keyDir: sandboxDir,
      machineKey,
      installationId,
      dpapiProvider: mockDpapi
    });

    // Tamper with the encrypted key file
    const corruptBytes = Buffer.from(fs.readFileSync(provResult.privateKeyPath));
    corruptBytes[0] ^= 0xFF; // Flip bits
    fs.writeFileSync(provResult.privateKeyPath, corruptBytes);

    expect(() => {
      installationKey.loadInstallationKey({
        keyDir: sandboxDir,
        machineKey,
        installationId,
        dpapiProvider: mockDpapi
      });
    }).toThrow();
  });

  test('7. Missing or whitespace-only machineKey is rejected fail-closed', () => {
    expect(() => {
      installationKey.provisionInstallationKey({
        keyDir: sandboxDir,
        machineKey: '',
        installationId: crypto.randomUUID(),
        dpapiProvider: mockDpapi
      });
    }).toThrow(/machineKey is required/i);

    expect(() => {
      installationKey.provisionInstallationKey({
        keyDir: sandboxDir,
        machineKey: '   ',
        installationId: crypto.randomUUID(),
        dpapiProvider: mockDpapi
      });
    }).toThrow(/machineKey is required/i);
  });

  test('8. Public/private key mismatch is detected and rejected', () => {
    const keypair1 = installationKey.generateInstallationKeyPair();
    const keypair2 = installationKey.generateInstallationKeyPair();

    const priv1 = installationKey.reconstructPrivateKey(keypair1.privateKeyScalar, keypair1.publicKeyPem);

    expect(() => {
      installationKey.validateKeyPair(priv1, keypair2.publicKeyPem);
    }).toThrow(/mathematically valid/i);
  });

  test('9. Refuses silent overwrite of existing installation keys without forceReprovision', () => {
    const machineKey = 'mk_test_existing';
    const installationId = crypto.randomUUID();

    installationKey.provisionInstallationKey({
      keyDir: sandboxDir,
      machineKey,
      installationId,
      dpapiProvider: mockDpapi
    });

    expect(() => {
      installationKey.provisionInstallationKey({
        keyDir: sandboxDir,
        machineKey,
        installationId,
        dpapiProvider: mockDpapi,
        forceReprovision: false
      });
    }).toThrow(/Refusing silent overwrite/i);
  });

  test('10. Authorized force-reprovision successfully generates fresh keys', () => {
    const machineKey = 'mk_test_force';
    const id1 = crypto.randomUUID();

    const res1 = installationKey.provisionInstallationKey({
      keyDir: sandboxDir,
      machineKey,
      installationId: id1,
      dpapiProvider: mockDpapi
    });

    const id2 = crypto.randomUUID();
    const res2 = installationKey.provisionInstallationKey({
      keyDir: sandboxDir,
      machineKey,
      installationId: id2,
      dpapiProvider: mockDpapi,
      forceReprovision: true
    });

    expect(res2.success).toBe(true);
    expect(res2.installationId).toBe(id2);
    expect(res2.keyFingerprint).not.toBe(res1.keyFingerprint);
  });

  test('11. No fallback keys are generated on missing key files', () => {
    expect(() => {
      installationKey.loadInstallationKey({
        keyDir: sandboxDir,
        machineKey: 'mk_no_fallback',
        installationId: crypto.randomUUID(),
        dpapiProvider: mockDpapi
      });
    }).toThrow(/Installation private key file missing/i);
  });

  test('12. No secret material in error messages or stringified error objects', () => {
    try {
      installationKey.deriveKeyEntropy('   ', 'inst_01');
    } catch (err) {
      expect(err.message).not.toContain('d:');
      expect(err.message).not.toContain('Buffer');
      expect(err.name).toBe('InstallationKeyError');
    }
  });

  test('13. End-to-end provision, load, and challenge-response signature workflow', () => {
    const machineKey = 'mk_e2e_production_grade_key';
    const installationId = crypto.randomUUID();

    const prov = installationKey.provisionInstallationKey({
      keyDir: sandboxDir,
      machineKey,
      installationId,
      dpapiProvider: mockDpapi
    });

    const loaded = installationKey.loadInstallationKey({
      keyDir: sandboxDir,
      machineKey,
      installationId,
      dpapiProvider: mockDpapi
    });

    expect(loaded.installationId).toBe(installationId);
    expect(loaded.keyFingerprint).toBe(prov.keyFingerprint);

    // Simulate backend challenge verification
    const challengeNonce = crypto.randomBytes(32);
    const signature = crypto.sign('sha256', challengeNonce, loaded.privateKey);

    const verified = crypto.verify('sha256', challengeNonce, loaded.publicKey, signature);
    expect(verified).toBe(true);
  });
});
