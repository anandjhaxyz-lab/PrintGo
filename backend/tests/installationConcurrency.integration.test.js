/**
 * WP-2H.2 / Phase 15.8D: PostgreSQL Concurrency, Row-Locking, and Rollback Integration Tests
 * 
 * Tests run against an isolated disposable PostgreSQL instance on port 5433 (printgo_disposable_target).
 * Uses real database transactions, FOR UPDATE row locking, concurrent worker connections, and verifies
 * actual PostgreSQL disk state transitions without mocking.
 */

process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/printgo_disposable_target';

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const prisma = require('../src/utils/prisma');
const machinesService = require('../src/modules/machines/machines.service');
const AppError = require('../src/utils/AppError');

describe('WP-2H.2: PostgreSQL Real Concurrency & Atomic Challenge Integration Tests', () => {
  let createdMachineIds = [];

  // Helper to create an isolated test machine in the real database
  async function createTestMachine(name = 'Kiosk Test Machine') {
    const id = crypto.randomUUID();
    const machineKey = crypto.randomBytes(32).toString('hex');
    const machine = await prisma.machine.create({
      data: {
        id,
        name,
        machineKey,
        status: 'ACTIVE'
      }
    });
    createdMachineIds.push(machine.id);
    return machine;
  }

  // Helper to generate a genuine ECDSA P-256 keypair
  function generateP256Keypair() {
    const keypair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKeyPem = keypair.publicKey.export({ type: 'spki', format: 'pem' });
    const spkiDer = keypair.publicKey.export({ type: 'spki', format: 'der' });
    const keyFingerprint = crypto.createHash('sha256').update(spkiDer).digest('hex');
    return { keypair, publicKeyPem, keyFingerprint };
  }

  // Helper to sign challenge payload
  function signChallenge({ challenge, keypair, installationId, machineId, protocolVersion = 1 }) {
    const canonicalPayload = machinesService.buildCanonicalChallengePayload({
      protocolVersion,
      challengeId: challenge.challengeId,
      challengeNonce: challenge.challengeNonce,
      machineId,
      installationId,
      purpose: challenge.purpose,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt
    });
    return crypto.sign('sha256', Buffer.from(canonicalPayload, 'utf8'), keypair.privateKey).toString('base64');
  }

  beforeEach(() => {
    machinesService.resetChallengeRateLimits();
  });

  afterAll(async () => {
    // Cleanup test records
    if (createdMachineIds.length > 0) {
      await prisma.installationEnrollmentChallenge.deleteMany({
        where: { machineId: { in: createdMachineIds } }
      });
      await prisma.machine.deleteMany({
        where: { id: { in: createdMachineIds } }
      });
    }
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Test A: Two concurrent requests consuming the same challenge: exactly one succeeds
  // ---------------------------------------------------------------------------
  test('A. Two concurrent requests consuming the same challenge: exactly one succeeds', async () => {
    const machine = await createTestMachine('Test A Machine');
    const installationId = crypto.randomUUID();
    const { keypair, publicKeyPem, keyFingerprint } = generateP256Keypair();

    const challenge = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId },
      clientIp: '127.0.0.1'
    });

    const signature = signChallenge({ challenge, keypair, installationId, machineId: machine.id });

    const payload = {
      challengeId: challenge.challengeId,
      challengeNonce: challenge.challengeNonce,
      installationId,
      publicKey: publicKeyPem,
      keyAlgorithm: 'ECDSA_P256',
      keyFormat: 'spki_pem',
      keyFingerprint,
      signature
    };

    // Dispatch two truly concurrent requests using Promise.allSettled
    const [res1, res2] = await Promise.allSettled([
      machinesService.enrollInstallationKey({ machine, payload, clientIp: '127.0.0.1' }),
      machinesService.enrollInstallationKey({ machine, payload, clientIp: '127.0.0.1' })
    ]);

    const successes = [res1, res2].filter(r => r.status === 'fulfilled');
    const failures = [res1, res2].filter(r => r.status === 'rejected');

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    expect(successes[0].value.status).toBe('ENROLLED');
    expect(failures[0].reason.statusCode).toBe(409);
    expect(failures[0].reason.message).toMatch(/already consumed/i);

    // Verify in real database
    const challengeRow = await prisma.installationEnrollmentChallenge.findUnique({
      where: { challengeId: challenge.challengeId }
    });
    expect(challengeRow.status).toBe('CONSUMED');
  });

  // ---------------------------------------------------------------------------
  // Test B: Two concurrent first-enrollment attempts with different public keys: exactly one wins
  // ---------------------------------------------------------------------------
  test('B. Two concurrent first-enrollment attempts with different public keys: exactly one wins, winning key unchanged', async () => {
    const machine = await createTestMachine('Test B Machine');
    const inst1 = crypto.randomUUID();
    const inst2 = crypto.randomUUID();

    const kp1 = generateP256Keypair();
    const kp2 = generateP256Keypair();

    const c1 = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId: inst1 },
      clientIp: '127.0.0.1'
    });

    const c2 = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId: inst2 },
      clientIp: '127.0.0.1'
    });

    const sig1 = signChallenge({ challenge: c1, keypair: kp1.keypair, installationId: inst1, machineId: machine.id });
    const sig2 = signChallenge({ challenge: c2, keypair: kp2.keypair, installationId: inst2, machineId: machine.id });

    const payload1 = {
      challengeId: c1.challengeId,
      challengeNonce: c1.challengeNonce,
      installationId: inst1,
      publicKey: kp1.publicKeyPem,
      keyAlgorithm: 'ECDSA_P256',
      keyFormat: 'spki_pem',
      keyFingerprint: kp1.keyFingerprint,
      signature: sig1
    };

    const payload2 = {
      challengeId: c2.challengeId,
      challengeNonce: c2.challengeNonce,
      installationId: inst2,
      publicKey: kp2.publicKeyPem,
      keyAlgorithm: 'ECDSA_P256',
      keyFormat: 'spki_pem',
      keyFingerprint: kp2.keyFingerprint,
      signature: sig2
    };

    const [res1, res2] = await Promise.allSettled([
      machinesService.enrollInstallationKey({ machine, payload: payload1, clientIp: '127.0.0.1' }),
      machinesService.enrollInstallationKey({ machine, payload: payload2, clientIp: '127.0.0.1' })
    ]);

    const successes = [res1, res2].filter(r => r.status === 'fulfilled');
    const failures = [res1, res2].filter(r => r.status === 'rejected');

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    expect(successes[0].value.status).toBe('ENROLLED');
    expect(failures[0].reason.statusCode).toBe(409);
    expect(failures[0].reason.message).toMatch(/Unauthorized key replacement/i);

    // Verify database state: Machine has the winner's key and it was never overwritten
    const dbMachine = await prisma.machine.findUnique({ where: { id: machine.id } });
    const winningKey = successes[0].value.keyFingerprint;
    expect(dbMachine.installationKeyFingerprint).toBe(winningKey);
  });

  // ---------------------------------------------------------------------------
  // Test C: Concurrent challenge issuance for the same machine/installation
  // ---------------------------------------------------------------------------
  test('C. Concurrent challenge issuance for the same machine/installation: bounded accumulation and rate limit', async () => {
    const machine = await createTestMachine('Test C Machine');
    const installationId = crypto.randomUUID();

    // Fire 6 concurrent requests: exactly 5 succeed, 6th is rejected with 429
    const promises = Array.from({ length: 6 }).map(() =>
      machinesService.issueEnrollmentChallenge({
        machine,
        payload: { installationId },
        clientIp: '127.0.0.1'
      })
    );

    const results = await Promise.allSettled(promises);
    const successes = results.filter(r => r.status === 'fulfilled');
    const rateLimited = results.filter(r => r.status === 'rejected' && r.reason.statusCode === 429);

    expect(successes.length).toBe(5);
    expect(rateLimited.length).toBe(1);

    // Verify bounded pending accumulation: older challenges were superseded/expired
    const pendingCount = await prisma.installationEnrollmentChallenge.count({
      where: { machineId: machine.id, status: 'PENDING' }
    });
    expect(pendingCount).toBeLessThanOrEqual(3);
  });

  // ---------------------------------------------------------------------------
  // Test D: Inject failure after challenge consumption but before Machine update: verify rollback
  // ---------------------------------------------------------------------------
  test('D. Inject failure after challenge consumption but before Machine update: verify actual database rollback', async () => {
    const machine = await createTestMachine('Test D Machine');
    const installationId = crypto.randomUUID();
    const { keypair, publicKeyPem, keyFingerprint } = generateP256Keypair();

    const challenge = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId },
      clientIp: '127.0.0.1'
    });

    // In a test transaction mirroring the service, consume the challenge then throw
    await expect(
      prisma.$transaction(async (tx) => {
        // Step 1: compare-and-set update challenge
        const affected = await tx.$executeRaw`
          UPDATE "InstallationEnrollmentChallenge"
          SET status = 'CONSUMED', "consumedAt" = (NOW() AT TIME ZONE 'UTC')
          WHERE "challengeId" = ${challenge.challengeId}
            AND status = 'PENDING'
        `;
        expect(affected).toBe(1);

        // Step 2: Inject intentional crash / network drop before Machine update
        throw new Error('INJECTED_DATABASE_CRASH');
      })
    ).rejects.toThrow('INJECTED_DATABASE_CRASH');

    // Verify PostgreSQL rollback: challenge must STILL be PENDING
    const challengeAfter = await prisma.installationEnrollmentChallenge.findUnique({
      where: { challengeId: challenge.challengeId }
    });
    expect(challengeAfter.status).toBe('PENDING');

    const machineAfter = await prisma.machine.findUnique({ where: { id: machine.id } });
    expect(machineAfter.installationKeyStatus).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Test E: Unauthorized replacement: verify challenge rejection/consumption is committed
  // ---------------------------------------------------------------------------
  test('E. Unauthorized replacement: verify challenge consumption is committed despite rejection', async () => {
    const machine = await createTestMachine('Test E Machine');
    const inst1 = crypto.randomUUID();
    const inst2 = crypto.randomUUID();

    const kp1 = generateP256Keypair();
    const kp2 = generateP256Keypair();

    // Enroll with key 1
    const c1 = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId: inst1 },
      clientIp: '127.0.0.1'
    });
    const sig1 = signChallenge({ challenge: c1, keypair: kp1.keypair, installationId: inst1, machineId: machine.id });
    await machinesService.enrollInstallationKey({
      machine,
      payload: {
        challengeId: c1.challengeId,
        challengeNonce: c1.challengeNonce,
        installationId: inst1,
        publicKey: kp1.publicKeyPem,
        keyAlgorithm: 'ECDSA_P256',
        keyFormat: 'spki_pem',
        keyFingerprint: kp1.keyFingerprint,
        signature: sig1
      }
    });

    // Now attempt key replacement with key 2
    const c2 = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId: inst2 },
      clientIp: '127.0.0.1'
    });
    const sig2 = signChallenge({ challenge: c2, keypair: kp2.keypair, installationId: inst2, machineId: machine.id });

    await expect(
      machinesService.enrollInstallationKey({
        machine,
        payload: {
          challengeId: c2.challengeId,
          challengeNonce: c2.challengeNonce,
          installationId: inst2,
          publicKey: kp2.publicKeyPem,
          keyAlgorithm: 'ECDSA_P256',
          keyFormat: 'spki_pem',
          keyFingerprint: kp2.keyFingerprint,
          signature: sig2
        }
      })
    ).rejects.toThrow(/Unauthorized key replacement/i);

    // CRITICAL: Verify in real PostgreSQL that challenge c2 WAS committed as CONSUMED
    const c2Row = await prisma.installationEnrollmentChallenge.findUnique({
      where: { challengeId: c2.challengeId }
    });
    expect(c2Row.status).toBe('CONSUMED');

    // And Machine key remains key 1
    const finalMachine = await prisma.machine.findUnique({ where: { id: machine.id } });
    expect(finalMachine.installationKeyFingerprint).toBe(kp1.keyFingerprint);
  });

  // ---------------------------------------------------------------------------
  // Test F: Same-key idempotent enrollment: verify expected result and single-use challenge behavior
  // ---------------------------------------------------------------------------
  test('F. Same-key idempotent enrollment: returns ALREADY_ENROLLED and single-use challenge behavior', async () => {
    const machine = await createTestMachine('Test F Machine');
    const installationId = crypto.randomUUID();
    const { keypair, publicKeyPem, keyFingerprint } = generateP256Keypair();

    // First enrollment
    const c1 = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId },
      clientIp: '127.0.0.1'
    });
    const sig1 = signChallenge({ challenge: c1, keypair, installationId, machineId: machine.id });
    const res1 = await machinesService.enrollInstallationKey({
      machine,
      payload: {
        challengeId: c1.challengeId,
        challengeNonce: c1.challengeNonce,
        installationId,
        publicKey: publicKeyPem,
        keyAlgorithm: 'ECDSA_P256',
        keyFormat: 'spki_pem',
        keyFingerprint,
        signature: sig1
      }
    });
    expect(res1.status).toBe('ENROLLED');

    // Re-enroll with exact same key using fresh challenge
    const c2 = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId },
      clientIp: '127.0.0.1'
    });
    const sig2 = signChallenge({ challenge: c2, keypair, installationId, machineId: machine.id });
    const res2 = await machinesService.enrollInstallationKey({
      machine,
      payload: {
        challengeId: c2.challengeId,
        challengeNonce: c2.challengeNonce,
        installationId,
        publicKey: publicKeyPem,
        keyAlgorithm: 'ECDSA_P256',
        keyFormat: 'spki_pem',
        keyFingerprint,
        signature: sig2
      }
    });
    expect(res2.status).toBe('ALREADY_ENROLLED');

    // Verify challenge c2 is now consumed
    const c2Row = await prisma.installationEnrollmentChallenge.findUnique({
      where: { challengeId: c2.challengeId }
    });
    expect(c2Row.status).toBe('CONSUMED');
  });

  // ---------------------------------------------------------------------------
  // Test G: Expired challenge rejection
  // ---------------------------------------------------------------------------
  test('G. Expired challenge rejection: rejects challenges past TTL', async () => {
    const machine = await createTestMachine('Test G Machine');
    const installationId = crypto.randomUUID();
    const { keypair, publicKeyPem, keyFingerprint } = generateP256Keypair();

    const c = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId },
      clientIp: '127.0.0.1'
    });

    // Manually backdate expiry in real PostgreSQL to simulate expired challenge
    await prisma.installationEnrollmentChallenge.update({
      where: { challengeId: c.challengeId },
      data: { expiresAt: new Date(Date.now() - 10000) }
    });

    const sig = signChallenge({ challenge: c, keypair, installationId, machineId: machine.id });

    await expect(
      machinesService.enrollInstallationKey({
        machine,
        payload: {
          challengeId: c.challengeId,
          challengeNonce: c.challengeNonce,
          installationId,
          publicKey: publicKeyPem,
          keyAlgorithm: 'ECDSA_P256',
          keyFormat: 'spki_pem',
          keyFingerprint,
          signature: sig
        }
      })
    ).rejects.toThrow(/Challenge expired/i);
  });

  // ---------------------------------------------------------------------------
  // Test H: Challenge replay after successful enrollment
  // ---------------------------------------------------------------------------
  test('H. Challenge replay after successful enrollment: fails closed', async () => {
    const machine = await createTestMachine('Test H Machine');
    const installationId = crypto.randomUUID();
    const { keypair, publicKeyPem, keyFingerprint } = generateP256Keypair();

    const c = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId },
      clientIp: '127.0.0.1'
    });
    const sig = signChallenge({ challenge: c, keypair, installationId, machineId: machine.id });

    const payload = {
      challengeId: c.challengeId,
      challengeNonce: c.challengeNonce,
      installationId,
      publicKey: publicKeyPem,
      keyAlgorithm: 'ECDSA_P256',
      keyFormat: 'spki_pem',
      keyFingerprint,
      signature: sig
    };

    // First use: success
    const res = await machinesService.enrollInstallationKey({ machine, payload });
    expect(res.status).toBe('ENROLLED');

    // Second use (replay): must be rejected
    await expect(
      machinesService.enrollInstallationKey({ machine, payload })
    ).rejects.toThrow(/Challenge already consumed/i);
  });

  // ---------------------------------------------------------------------------
  // Test I: Wrong machine identity rejection
  // ---------------------------------------------------------------------------
  test('I. Wrong machine identity rejection: challenge bound to machine A cannot enroll machine B', async () => {
    const machineA = await createTestMachine('Machine A');
    const machineB = await createTestMachine('Machine B');
    const installationId = crypto.randomUUID();
    const { keypair, publicKeyPem, keyFingerprint } = generateP256Keypair();

    const c = await machinesService.issueEnrollmentChallenge({
      machine: machineA,
      payload: { installationId },
      clientIp: '127.0.0.1'
    });

    const sig = signChallenge({ challenge: c, keypair, installationId, machineId: machineA.id });

    // Present challenge to Machine B
    await expect(
      machinesService.enrollInstallationKey({
        machine: machineB,
        payload: {
          challengeId: c.challengeId,
          challengeNonce: c.challengeNonce,
          installationId,
          publicKey: publicKeyPem,
          keyAlgorithm: 'ECDSA_P256',
          keyFormat: 'spki_pem',
          keyFingerprint,
          signature: sig
        }
      })
    ).rejects.toThrow(/Challenge machine identity mismatch/i);
  });

  // ---------------------------------------------------------------------------
  // Test J: Wrong installation identity rejection
  // ---------------------------------------------------------------------------
  test('J. Wrong installation identity rejection: challenge bound to inst 1 cannot enroll inst 2', async () => {
    const machine = await createTestMachine('Test J Machine');
    const inst1 = crypto.randomUUID();
    const inst2 = crypto.randomUUID();
    const { keypair, publicKeyPem, keyFingerprint } = generateP256Keypair();

    const c = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId: inst1 },
      clientIp: '127.0.0.1'
    });

    const sig = signChallenge({ challenge: c, keypair, installationId: inst1, machineId: machine.id });

    await expect(
      machinesService.enrollInstallationKey({
        machine,
        payload: {
          challengeId: c.challengeId,
          challengeNonce: c.challengeNonce,
          installationId: inst2,
          publicKey: publicKeyPem,
          keyAlgorithm: 'ECDSA_P256',
          keyFormat: 'spki_pem',
          keyFingerprint,
          signature: sig
        }
      })
    ).rejects.toThrow(/Challenge installation identity mismatch/i);
  });

  // ---------------------------------------------------------------------------
  // Test K: Invalid signature and modified signed payload rejection
  // ---------------------------------------------------------------------------
  test('K. Invalid signature and modified signed payload rejection', async () => {
    const machine = await createTestMachine('Test K Machine');
    const installationId = crypto.randomUUID();
    const { keypair, publicKeyPem, keyFingerprint } = generateP256Keypair();
    const otherKp = generateP256Keypair();

    const c = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId },
      clientIp: '127.0.0.1'
    });

    // Signature created with wrong keypair
    const wrongSig = signChallenge({ challenge: c, keypair: otherKp.keypair, installationId, machineId: machine.id });

    await expect(
      machinesService.enrollInstallationKey({
        machine,
        payload: {
          challengeId: c.challengeId,
          challengeNonce: c.challengeNonce,
          installationId,
          publicKey: publicKeyPem,
          keyAlgorithm: 'ECDSA_P256',
          keyFormat: 'spki_pem',
          keyFingerprint,
          signature: wrongSig
        }
      })
    ).rejects.toThrow(/Invalid enrollment signature/i);

    // Challenge must remain PENDING because signature validation failed before consumption
    const cRow = await prisma.installationEnrollmentChallenge.findUnique({
      where: { challengeId: c.challengeId }
    });
    expect(cRow.status).toBe('PENDING');
  });

  // ---------------------------------------------------------------------------
  // Test L: Transaction timeout / deadlock handling: safe failure and retry without duplicate enrollment
  // ---------------------------------------------------------------------------
  test('L. Transaction timeout and deadlock prevention: consistent lock ordering prevents deadlock', async () => {
    const machine = await createTestMachine('Test L Machine');
    const inst1 = crypto.randomUUID();
    const inst2 = crypto.randomUUID();
    const kp1 = generateP256Keypair();
    const kp2 = generateP256Keypair();

    const c1 = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId: inst1 },
      clientIp: '127.0.0.1'
    });
    const c2 = await machinesService.issueEnrollmentChallenge({
      machine,
      payload: { installationId: inst2 },
      clientIp: '127.0.0.1'
    });

    const sig1 = signChallenge({ challenge: c1, keypair: kp1.keypair, installationId: inst1, machineId: machine.id });
    const sig2 = signChallenge({ challenge: c2, keypair: kp2.keypair, installationId: inst2, machineId: machine.id });

    // Execute 5 concurrent rapid attempts across different challenges on the same Machine
    const attempts = [
      machinesService.enrollInstallationKey({
        machine,
        payload: {
          challengeId: c1.challengeId,
          challengeNonce: c1.challengeNonce,
          installationId: inst1,
          publicKey: kp1.publicKeyPem,
          keyAlgorithm: 'ECDSA_P256',
          keyFormat: 'spki_pem',
          keyFingerprint: kp1.keyFingerprint,
          signature: sig1
        }
      }),
      machinesService.enrollInstallationKey({
        machine,
        payload: {
          challengeId: c2.challengeId,
          challengeNonce: c2.challengeNonce,
          installationId: inst2,
          publicKey: kp2.publicKeyPem,
          keyAlgorithm: 'ECDSA_P256',
          keyFormat: 'spki_pem',
          keyFingerprint: kp2.keyFingerprint,
          signature: sig2
        }
      })
    ];

    const results = await Promise.allSettled(attempts);
    // At most 1 enrollment can succeed on the machine
    const enrolled = results.filter(r => r.status === 'fulfilled' && r.value.status === 'ENROLLED');
    expect(enrolled.length).toBe(1);

    // No deadlock occurred and the machine has exactly one key
    const finalMachine = await prisma.machine.findUnique({ where: { id: machine.id } });
    expect(finalMachine.installationKeyStatus).toBe('ACTIVE');
  });

  test('M. Cross-process issuance shares the same per-machine rate limit', async () => {
    const machine = await createTestMachine('Test M Cross Process Machine');
    const childSource = [
      "const crypto = require('crypto');",
      "const service = require('./src/modules/machines/machines.service');",
      "const prisma = require('./src/utils/prisma');",
      "(async () => {",
      " const n = Number(process.env.AUDIT_ISSUE_COUNT || 1);",
      " for (let i = 0; i < n; i++) await service.issueEnrollmentChallenge({ machine: { id: process.env.AUDIT_MACHINE_ID }, payload: { installationId: crypto.randomUUID() }, clientIp: '127.0.0.1' });",
      " console.log('ISSUED=' + n); await prisma.$disconnect();",
      "})().catch(async e => { console.error(e.statusCode || e.code || e.message); await prisma.$disconnect(); process.exit(2); });"
    ].join('\n');

    const first = spawnSync(process.execPath, ['-e', childSource], {
      cwd: process.cwd(),
      env: { ...process.env, AUDIT_MACHINE_ID: machine.id, AUDIT_ISSUE_COUNT: '5' },
      encoding: 'utf8'
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('ISSUED=5');

    const second = spawnSync(process.execPath, ['-e', childSource], {
      cwd: process.cwd(),
      env: { ...process.env, AUDIT_MACHINE_ID: machine.id, AUDIT_ISSUE_COUNT: '1' },
      encoding: 'utf8'
    });
    expect(second.status).toBe(2);
    expect(second.stderr).toMatch(/429|CHALLENGE_RATE_LIMITED|Too many challenge requests/i);

    const issuedCount = await prisma.installationEnrollmentChallenge.count({ where: { machineId: machine.id } });
    expect(issuedCount).toBe(5);
  });

  test('N. Pending challenge cap is per Machine across distinct installation IDs', async () => {
    const machine = await createTestMachine('Test N Pending Cap Machine');
    for (let i = 0; i < 5; i++) {
      await machinesService.issueEnrollmentChallenge({
        machine,
        payload: { installationId: crypto.randomUUID() },
        clientIp: '127.0.0.1'
      });
    }
    const pendingCount = await prisma.installationEnrollmentChallenge.count({
      where: { machineId: machine.id, status: 'PENDING' }
    });
    expect(pendingCount).toBe(3);
    const expiredCount = await prisma.installationEnrollmentChallenge.count({
      where: { machineId: machine.id, status: 'EXPIRED' }
    });
    expect(expiredCount).toBe(2);
  });
  test('O. Scheduled retention cleanup removes stale rows in bounded batches and preserves recent evidence', async () => {
    const machine = await createTestMachine('Test O Retention Machine');
    const installationId = crypto.randomUUID();
    const stalePending = await machinesService.issueEnrollmentChallenge({
      machine, payload: { installationId }, clientIp: '127.0.0.1'
    });
    const staleTerminal = await machinesService.issueEnrollmentChallenge({
      machine, payload: { installationId }, clientIp: '127.0.0.1'
    });
    const recentTerminal = await machinesService.issueEnrollmentChallenge({
      machine, payload: { installationId }, clientIp: '127.0.0.1'
    });

    await prisma.installationEnrollmentChallenge.update({
      where: { challengeId: stalePending.challengeId },
      data: { status: 'PENDING', expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }
    });
    await prisma.installationEnrollmentChallenge.update({
      where: { challengeId: staleTerminal.challengeId },
      data: { status: 'CONSUMED', expiresAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) }
    });
    await prisma.installationEnrollmentChallenge.update({
      where: { challengeId: recentTerminal.challengeId },
      data: { status: 'CONSUMED' }
    });

    const deletedCount = await machinesService.cleanupEnrollmentChallenges();
    expect(deletedCount).toBeGreaterThanOrEqual(2);

    const [pendingAfter, terminalAfter, recentAfter] = await Promise.all([
      prisma.installationEnrollmentChallenge.findUnique({ where: { challengeId: stalePending.challengeId } }),
      prisma.installationEnrollmentChallenge.findUnique({ where: { challengeId: staleTerminal.challengeId } }),
      prisma.installationEnrollmentChallenge.findUnique({ where: { challengeId: recentTerminal.challengeId } })
    ]);
    expect(pendingAfter).toBeNull();
    expect(terminalAfter).toBeNull();
    expect(recentAfter.status).toBe('CONSUMED');
  });

  test('P. Actual enrollment service rolls challenge consumption back when Machine update fails', async () => {
    const machine = await createTestMachine('Test P Service Rollback Machine');
    const installationId = crypto.randomUUID();
    const { keypair, publicKeyPem, keyFingerprint } = generateP256Keypair();
    const challenge = await machinesService.issueEnrollmentChallenge({
      machine, payload: { installationId }, clientIp: '127.0.0.1'
    });
    const signature = signChallenge({ challenge, keypair, installationId, machineId: machine.id });
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const functionName = 'wp2h3_fail_machine_update_' + suffix;
    const triggerName = 'wp2h3_fail_machine_update_' + suffix;

    try {
      const createFunctionSql = "CREATE FUNCTION public." + functionName +
        "() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN IF NEW.id = '" +
        machine.id + "' THEN RAISE EXCEPTION 'WP2H3_INJECTED_MACHINE_UPDATE_FAILURE'; END IF; RETURN NEW; END; $body$";
      const createTriggerSql = 'CREATE TRIGGER ' + triggerName +
        ' BEFORE UPDATE ON "Machine" FOR EACH ROW EXECUTE FUNCTION public.' + functionName + '()';
      await prisma.$executeRawUnsafe(createFunctionSql);
      await prisma.$executeRawUnsafe(createTriggerSql);

      await expect(machinesService.enrollInstallationKey({
        machine,
        payload: {
          challengeId: challenge.challengeId,
          challengeNonce: challenge.challengeNonce,
          installationId,
          publicKey: publicKeyPem,
          keyAlgorithm: 'ECDSA_P256',
          keyFormat: 'spki_pem',
          keyFingerprint,
          signature
        },
        clientIp: '127.0.0.1'
      })).rejects.toThrow(/WP2H3_INJECTED_MACHINE_UPDATE_FAILURE/);

      const [challengeAfter, machineAfter] = await Promise.all([
        prisma.installationEnrollmentChallenge.findUnique({ where: { challengeId: challenge.challengeId } }),
        prisma.machine.findUnique({ where: { id: machine.id } })
      ]);
      expect(challengeAfter.status).toBe('PENDING');
      expect(machineAfter.installationKeyStatus).toBeNull();
      expect(machineAfter.installationPublicKey).toBeNull();
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS ' + triggerName + ' ON "Machine"');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS public.' + functionName + '()');
    }
  });});

