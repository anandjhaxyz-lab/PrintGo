const crypto = require('crypto');
const prisma = require('../src/utils/prisma');
const machinesService = require('../src/modules/machines/machines.service');
const AppError = require('../src/utils/AppError');

jest.mock('../src/utils/prisma', () => {
  const mockClient = {
    machine: {
      findUnique: jest.fn(),
      update: jest.fn()
    },
    installationEnrollmentChallenge: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn()
    }
  };
  mockClient.$queryRaw = jest.fn(async (query) => {
    const sql = query && query.sql ? query.sql : '';
    if (sql.includes('COUNT(*)')) {
      const machineId = query.values && query.values[0];
      const count = mockClient.installationEnrollmentChallenge.create.mock.calls.filter(call => call[0].data.machineId === machineId).length;
      return [{ requestCount: count }];
    }
    if (sql.includes('FROM "Machine"')) {
      const machine = await mockClient.machine.findUnique();
      return [{ id: machine && machine.id ? machine.id : 'm_test_uuid_001', ...(machine || {}) }];
    }
    if (sql.includes('FROM "InstallationEnrollmentChallenge"')) {
      const challenge = await mockClient.installationEnrollmentChallenge.findUnique();
      return challenge ? [challenge] : [];
    }
    return [];
  });
  mockClient.$executeRaw = jest.fn().mockResolvedValue(1);
  mockClient.$transaction = jest.fn(async (cb) => cb(mockClient));
  return mockClient;
});

describe('WP-2H.1 / Phase 15.8B: Server-Issued Challenge-Response & Atomic Enrollment Replay Protection', () => {
  let mockMachine;
  let testKeypair;
  let publicKeyPem;
  let validFingerprint;
  let installationId;

  beforeAll(() => {
    // Generate valid test ECDSA P-256 keypair
    testKeypair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    publicKeyPem = testKeypair.publicKey.export({ type: 'spki', format: 'pem' });
    const spkiDer = testKeypair.publicKey.export({ type: 'spki', format: 'der' });
    validFingerprint = crypto.createHash('sha256').update(spkiDer).digest('hex');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    installationId = crypto.randomUUID();
    mockMachine = {
      id: 'm_test_uuid_001',
      name: 'Kiosk North Wing',
      machineKey: 'mk_secret_hash_value',
      status: 'ACTIVE',
      installationPublicKey: null,
      activeInstallationId: null,
      installationKeyStatus: null
    };
  });

  // Helper to generate a valid challenge record and matching signed payload
  const createValidChallengeAndSignature = (overrides = {}) => {
    const challengeId = crypto.randomUUID();
    const rawNonce = crypto.randomBytes(32);
    const challengeNonce = rawNonce.toString('hex');
    const nonceHash = crypto.createHash('sha256').update(challengeNonce).digest('hex');
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 60000);

    const challengeRecord = {
      id: crypto.randomUUID(),
      challengeId,
      machineId: mockMachine.id,
      installationId,
      nonceHash,
      purpose: 'INSTALLATION_KEY_ENROLLMENT',
      status: 'PENDING',
      issuedAt,
      expiresAt,
      consumedAt: null,
      ...overrides
    };

    const canonicalPayload = machinesService.buildCanonicalChallengePayload({
      protocolVersion: 1,
      challengeId,
      challengeNonce,
      machineId: mockMachine.id,
      installationId,
      purpose: challengeRecord.purpose,
      issuedAt,
      expiresAt
    });

    const signature = crypto.sign('sha256', Buffer.from(canonicalPayload, 'utf8'), testKeypair.privateKey).toString('base64');

    const enrollmentPayload = {
      challengeId,
      challengeNonce,
      installationId,
      publicKey: publicKeyPem,
      keyAlgorithm: 'ECDSA_P256',
      keyFormat: 'spki_pem',
      keyFingerprint: validFingerprint,
      signature,
      protocolVersion: 1
    };

    return { challengeRecord, enrollmentPayload, challengeId, challengeNonce, signature };
  };

  test('1. Valid fresh challenge issuance returns 32-byte nonce and 60-second expiry', async () => {
    prisma.installationEnrollmentChallenge.create.mockImplementation(({ data }) => Promise.resolve({ id: 'c_01', ...data }));

    const res = await machinesService.issueEnrollmentChallenge({
      machine: mockMachine,
      payload: { installationId, purpose: 'INSTALLATION_KEY_ENROLLMENT' },
      clientIp: '127.0.0.1'
    });

    expect(res.success).toBe(true);
    expect(res.protocolVersion).toBe(1);
    expect(res.challengeId).toBeDefined();
    expect(typeof res.challengeNonce).toBe('string');
    // 32 bytes = 64 hex characters
    expect(res.challengeNonce.length).toBe(64);
    expect(Buffer.from(res.challengeNonce, 'hex').length).toBe(32);

    const issuedMs = new Date(res.issuedAt).getTime();
    const expiresMs = new Date(res.expiresAt).getTime();
    expect(expiresMs - issuedMs).toBe(60000); // 60 seconds TTL

    expect(prisma.installationEnrollmentChallenge.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        machineId: mockMachine.id,
        installationId,
        purpose: 'INSTALLATION_KEY_ENROLLMENT',
        status: 'PENDING'
      })
    }));
  });

  test('2. Rejects challenge issuance if machine identity or installationId is missing/invalid', async () => {
    await expect(machinesService.issueEnrollmentChallenge({
      machine: null,
      payload: { installationId }
    })).rejects.toThrow(/Valid machine identity missing/i);

    await expect(machinesService.issueEnrollmentChallenge({
      machine: mockMachine,
      payload: { installationId: 'invalid-id' }
    })).rejects.toThrow(/Must be a valid non-empty UUID string/i);
  });

  test('3. Rejects challenge issuance for invalid purpose', async () => {
    await expect(machinesService.issueEnrollmentChallenge({
      machine: mockMachine,
      payload: { installationId, purpose: 'ROGUE_PURPOSE' }
    })).rejects.toThrow(/Must be INSTALLATION_KEY_ENROLLMENT/i);
  });

  test('4. Atomic enrollment successfully consumes challenge and commits public key', async () => {
    const { challengeRecord, enrollmentPayload } = createValidChallengeAndSignature();

    prisma.installationEnrollmentChallenge.findUnique.mockResolvedValue(challengeRecord);
    prisma.installationEnrollmentChallenge.update.mockResolvedValue({ ...challengeRecord, status: 'CONSUMED' });
    prisma.machine.findUnique.mockResolvedValue(mockMachine);
    prisma.machine.update.mockImplementation(({ data }) => Promise.resolve({ ...mockMachine, ...data }));

    const result = await machinesService.enrollInstallationKey({
      machine: mockMachine,
      payload: enrollmentPayload,
      clientIp: '127.0.0.1'
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('ENROLLED');
    expect(result.keyStatus).toBe('ACTIVE');
    expect(result.keyFingerprint).toBe(validFingerprint);

    // Verify challenge marked consumed inside transaction
    expect(prisma.$executeRaw.mock.calls.some(([query]) => query.sql.includes("status = 'PENDING'") && query.sql.includes("SET status = 'CONSUMED'"))).toBe(true);

    // Verify machine enrolled inside transaction
    expect(prisma.machine.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: mockMachine.id },
      data: expect.objectContaining({
        installationPublicKey: publicKeyPem.trim(),
        activeInstallationId: installationId,
        installationKeyStatus: 'ACTIVE'
      })
    }));
  });

  test('5. Rejects legacy client-timestamp-only proofs missing challenge parameters', async () => {
    await expect(machinesService.enrollInstallationKey({
      machine: mockMachine,
      payload: {
        installationId,
        publicKey: publicKeyPem,
        keyAlgorithm: 'ECDSA_P256',
        keyFormat: 'spki_pem',
        proofOfPossession: { timestamp: new Date().toISOString(), signature: 'legacy' }
      }
    })).rejects.toThrow(/Client-timestamp-only proofs are rejected/i);
  });

  test('6. Rejects tampered challenge nonce (nonceHash mismatch)', async () => {
    const { challengeRecord, enrollmentPayload } = createValidChallengeAndSignature();
    // Tamper with nonce in payload
    enrollmentPayload.challengeNonce = crypto.randomBytes(32).toString('hex');

    prisma.installationEnrollmentChallenge.findUnique.mockResolvedValue(challengeRecord);

    await expect(machinesService.enrollInstallationKey({
      machine: mockMachine,
      payload: enrollmentPayload
    })).rejects.toThrow(/Tampered challenge nonce/i);
  });

  test('7. Rejects expired challenge (> 60 seconds old)', async () => {
    const { challengeRecord, enrollmentPayload } = createValidChallengeAndSignature({
      expiresAt: new Date(Date.now() - 5000)
    });

    prisma.installationEnrollmentChallenge.findUnique.mockResolvedValue(challengeRecord);

    await expect(machinesService.enrollInstallationKey({
      machine: mockMachine,
      payload: enrollmentPayload
    })).rejects.toThrow(/Challenge expired/i);
  });

  test('8. Rejects unknown challengeId (CHALLENGE_NOT_FOUND)', async () => {
    const { enrollmentPayload } = createValidChallengeAndSignature();
    prisma.installationEnrollmentChallenge.findUnique.mockResolvedValue(null);

    await expect(machinesService.enrollInstallationKey({
      machine: mockMachine,
      payload: enrollmentPayload
    })).rejects.toThrow(/Challenge not found/i);
  });

  test('9. Rejects reuse of already consumed challenge (CHALLENGE_ALREADY_CONSUMED)', async () => {
    const { challengeRecord, enrollmentPayload } = createValidChallengeAndSignature({
      status: 'CONSUMED',
      consumedAt: new Date(Date.now() - 10000)
    });

    prisma.installationEnrollmentChallenge.findUnique.mockResolvedValue(challengeRecord);

    await expect(machinesService.enrollInstallationKey({
      machine: mockMachine,
      payload: enrollmentPayload
    })).rejects.toThrow(/Challenge already consumed/i);
  });

  test('10. Rejects challenge issued for another machineId (CHALLENGE_MACHINE_MISMATCH)', async () => {
    const { challengeRecord, enrollmentPayload } = createValidChallengeAndSignature({
      machineId: 'm_OTHER_MACHINE'
    });

    prisma.installationEnrollmentChallenge.findUnique.mockResolvedValue(challengeRecord);

    await expect(machinesService.enrollInstallationKey({
      machine: mockMachine,
      payload: enrollmentPayload
    })).rejects.toThrow(/Challenge machine identity mismatch/i);
  });

  test('11. Rejects challenge issued for another installationId (CHALLENGE_INSTALLATION_MISMATCH)', async () => {
    const { challengeRecord, enrollmentPayload } = createValidChallengeAndSignature({
      installationId: crypto.randomUUID()
    });

    prisma.installationEnrollmentChallenge.findUnique.mockResolvedValue(challengeRecord);

    await expect(machinesService.enrollInstallationKey({
      machine: mockMachine,
      payload: enrollmentPayload
    })).rejects.toThrow(/Challenge installation identity mismatch/i);
  });

  test('12. Rejects invalid challenge signature against public key', async () => {
    const otherKeypair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { challengeRecord, enrollmentPayload } = createValidChallengeAndSignature();

    // Sign with wrong private key
    const canonicalPayload = machinesService.buildCanonicalChallengePayload({
      protocolVersion: 1,
      challengeId: challengeRecord.challengeId,
      challengeNonce: enrollmentPayload.challengeNonce,
      machineId: mockMachine.id,
      installationId,
      purpose: challengeRecord.purpose,
      issuedAt: challengeRecord.issuedAt,
      expiresAt: challengeRecord.expiresAt
    });

    enrollmentPayload.signature = crypto.sign('sha256', Buffer.from(canonicalPayload, 'utf8'), otherKeypair.privateKey).toString('base64');

    prisma.installationEnrollmentChallenge.findUnique.mockResolvedValue(challengeRecord);

    await expect(machinesService.enrollInstallationKey({
      machine: mockMachine,
      payload: enrollmentPayload
    })).rejects.toThrow(/Invalid enrollment signature/i);
  });

  test('13. Rejects unauthorized silent key replacement when machine already has an active enrolled key', async () => {
    const otherKeypair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const otherPubPem = otherKeypair.publicKey.export({ type: 'spki', format: 'pem' });
    const otherDer = otherKeypair.publicKey.export({ type: 'spki', format: 'der' });
    const otherFingerprint = crypto.createHash('sha256').update(otherDer).digest('hex');

    const enrolledMachine = {
      ...mockMachine,
      activeInstallationId: crypto.randomUUID(),
      installationPublicKey: otherPubPem.trim(),
      installationKeyAlgorithm: 'ECDSA_P256',
      installationKeyFormat: 'spki_pem',
      installationKeyFingerprint: otherFingerprint,
      installationKeyStatus: 'ACTIVE',
      installationEnrolledAt: new Date()
    };

    const { challengeRecord, enrollmentPayload } = createValidChallengeAndSignature();

    prisma.installationEnrollmentChallenge.findUnique.mockResolvedValue(challengeRecord);
    prisma.machine.findUnique.mockResolvedValue(enrolledMachine);
    prisma.installationEnrollmentChallenge.update.mockResolvedValue({ ...challengeRecord, status: 'CONSUMED' });

    await expect(machinesService.enrollInstallationKey({
      machine: enrolledMachine,
      payload: enrollmentPayload
    })).rejects.toThrow(/Unauthorized key replacement.*Recommissioning workflow required/i);

    // Challenge must be consumed even on rejection to prevent retry attacks
    expect(prisma.$executeRaw.mock.calls.some(([query]) => query.sql.includes("status = 'PENDING'") && query.sql.includes("SET status = 'CONSUMED'"))).toBe(true);
  });

  test('14. Idempotent re-enrollment of exact same key returns ALREADY_ENROLLED and marks challenge consumed', async () => {
    const enrolledMachine = {
      ...mockMachine,
      activeInstallationId: installationId,
      installationPublicKey: publicKeyPem.trim(),
      installationKeyAlgorithm: 'ECDSA_P256',
      installationKeyFormat: 'spki_pem',
      installationKeyFingerprint: validFingerprint,
      installationKeyStatus: 'ACTIVE',
      installationEnrolledAt: new Date()
    };

    const { challengeRecord, enrollmentPayload } = createValidChallengeAndSignature();

    prisma.installationEnrollmentChallenge.findUnique.mockResolvedValue(challengeRecord);
    prisma.machine.findUnique.mockResolvedValue(enrolledMachine);
    prisma.installationEnrollmentChallenge.update.mockResolvedValue({ ...challengeRecord, status: 'CONSUMED' });

    const res = await machinesService.enrollInstallationKey({
      machine: enrolledMachine,
      payload: enrollmentPayload
    });

    expect(res.success).toBe(true);
    expect(res.status).toBe('ALREADY_ENROLLED');
    expect(prisma.machine.update).not.toHaveBeenCalled();
    expect(prisma.$executeRaw.mock.calls.some(([query]) => query.sql.includes("status = 'PENDING'") && query.sql.includes("SET status = 'CONSUMED'"))).toBe(true);
  });

  test('15. Transaction rollback: If machine update throws, error bubbles and transaction aborts', async () => {
    const { challengeRecord, enrollmentPayload } = createValidChallengeAndSignature();

    prisma.installationEnrollmentChallenge.findUnique.mockResolvedValue(challengeRecord);
    prisma.installationEnrollmentChallenge.update.mockResolvedValue({ ...challengeRecord, status: 'CONSUMED' });
    prisma.machine.findUnique.mockResolvedValue(mockMachine);
    prisma.machine.update.mockRejectedValue(new Error('DATABASE_CONNECTION_LOST'));

    await expect(machinesService.enrollInstallationKey({
      machine: mockMachine,
      payload: enrollmentPayload
    })).rejects.toThrow(/DATABASE_CONNECTION_LOST/);
  });

  test('16. Challenge issuance rate limiting: Enforces maximum 5 requests per 60 seconds per machine identity', async () => {
    machinesService.resetChallengeRateLimits();
    prisma.installationEnrollmentChallenge.create.mockImplementation(({ data }) => Promise.resolve({ id: 'c_rl', ...data }));

    // First 5 requests must succeed
    for (let i = 0; i < 5; i++) {
      const res = await machinesService.issueEnrollmentChallenge({
        machine: mockMachine,
        payload: { installationId },
        clientIp: '127.0.0.1'
      });
      expect(res.success).toBe(true);
    }

    // 6th request within window must be rate limited with 429
    await expect(machinesService.issueEnrollmentChallenge({
      machine: mockMachine,
      payload: { installationId },
      clientIp: '127.0.0.1'
    })).rejects.toThrow(/Too many challenge requests for this machine/i);

    // Another machine is not affected
    const anotherMachine = { id: 'm_another_machine_999' };
    const anotherRes = await machinesService.issueEnrollmentChallenge({
      machine: anotherMachine,
      payload: { installationId },
      clientIp: '127.0.0.1'
    });
    expect(anotherRes.success).toBe(true);
  });

  test('17. Pending challenge accumulation is bounded, superseding older pending challenges', async () => {
    machinesService.resetChallengeRateLimits();
    prisma.installationEnrollmentChallenge.create = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'c_bound', ...data }));

    const res = await machinesService.issueEnrollmentChallenge({
      machine: mockMachine,
      payload: { installationId },
      clientIp: '127.0.0.1'
    });

    expect(res.success).toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining('FOR UPDATE')
    }));
    expect(prisma.$executeRaw).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining('WITH keep_pending')
    }));
  });

  test('18. Challenge issuance fails closed when PostgreSQL raw locking is unavailable', async () => {
    prisma.$transaction.mockImplementationOnce(async (cb) => cb({}));
    await expect(machinesService.issueEnrollmentChallenge({
      machine: mockMachine,
      payload: { installationId },
      clientIp: '127.0.0.1'
    })).rejects.toThrow(/PostgreSQL row-lock and atomic SQL capabilities are required/i);
  });

  test('19. Enrollment fails closed when PostgreSQL row-lock/CAS capabilities are unavailable', async () => {
    const { enrollmentPayload } = createValidChallengeAndSignature();
    prisma.$transaction.mockImplementationOnce(async (cb) => cb({}));
    await expect(machinesService.enrollInstallationKey({
      machine: mockMachine,
      payload: enrollmentPayload,
      clientIp: '127.0.0.1'
    })).rejects.toThrow(/PostgreSQL row-lock and conditional SQL capabilities are required/i);
  });});
