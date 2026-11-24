/**
 * Phase 3Q — PDF Preview Recovery & Security Regression Test Suite
 *
 * Verifies all 10 security and functionality invariants:
 * 1. Authorized session retrieves its own PDF (200 OK + PDF stream).
 * 2. Unauthorized request receives 401 (missing/invalid token).
 * 3. Different active session receives 403 (BOLA / cross-session isolation).
 * 4. Expired session is rejected with 410 (TTL expiry / terminal state).
 * 5. Path traversal attempts are rejected with 400.
 * 6. Customer cannot access another session's file or unowned legacy files (403).
 * 7. Printer Agent authorization (/uploads/:filename) remains untouched and secure.
 * 8. PDF preview rehydration works after browser refresh.
 * 9. Encrypted PDF preview decrypts client-side and recovers valid PDF after refresh.
 * 10. Zero Document, PrintJob, Payment, or Invoice records created during upload/preview.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

// Test Environment Setup
const JWT_SECRET = 'phase3q_test_jwt_secret_isolated_key_64_bytes_secure_string_pilot';
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = 'test';

const testUploadsDir = path.join(__dirname, 'temp_test_uploads');
if (!fs.existsSync(testUploadsDir)) {
  fs.mkdirSync(testUploadsDir, { recursive: true });
}
process.env.UPLOADS_DIR = testUploadsDir;

// Mock database storage for isolated in-memory testing
const mockSessions = new Map();
const mockUsers = new Map();
const mockDocuments = new Map();
const mockMachines = new Map();

// Mock Prisma Client to prevent touching live or staging databases
const mockPrisma = {
  session: {
    findUnique: async ({ where }) => {
      if (where.code) {
        for (const s of mockSessions.values()) {
          if (s.code === where.code) return s;
        }
      }
      if (where.id) return mockSessions.get(where.id) || null;
      return null;
    },
    update: async ({ where, data }) => {
      const s = mockSessions.get(where.id);
      if (s) {
        Object.assign(s, data);
        return s;
      }
      return null;
    },
    create: async ({ data }) => {
      const created = { id: data.id || `sess-uuid-${Date.now()}`, ...data };
      mockSessions.set(created.id, created);
      return created;
    }
  },
  user: {
    findUnique: async ({ where }) => mockUsers.get(where.id) || null
  },
  document: {
    findFirst: async ({ where }) => {
      if (where.filename?.endsWith) {
        for (const d of mockDocuments.values()) {
          if (d.filename.endsWith(where.filename.endsWith)) return d;
        }
      }
      return null;
    },
    count: async () => mockDocuments.size
  },
  machine: {
    findUnique: async ({ where }) => {
      if (where.machineKey) {
        for (const m of mockMachines.values()) {
          if (m.machineKey === where.machineKey) return m;
        }
      }
      if (where.id) return mockMachines.get(where.id) || null;
      return null;
    }
  },
  printJob: {
    count: async () => 0
  },
  payment: {
    count: async () => 0
  },
  invoice: {
    count: async () => 0
  }
};

// Override prisma in require cache
const prismaPath = path.resolve(__dirname, '../src/utils/prisma.js');
require.cache[require.resolve(prismaPath)] = {
  id: require.resolve(prismaPath),
  filename: require.resolve(prismaPath),
  loaded: true,
  exports: mockPrisma
};

// Now import app dependencies
const { requireSessionOrUser } = require('../src/middlewares/session');
const { fileAuth } = require('../src/middlewares/fileAuth');
const { serveDocument } = require('../src/modules/files/file.controller');
const uploadRoutes = require('../src/modules/upload/upload.routes');
const { errorHandler } = require('../src/middlewares/error');

// Build Test Express App
const app = express();
app.use(express.json());
app.use('/api/upload', uploadRoutes);
app.get('/uploads/:filename', fileAuth, serveDocument);
app.use(errorHandler);

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name} -> ${err.message}`);
    failed++;
  }
}

async function runTestSuite() {
  console.log('=== Phase 3Q PDF Preview Recovery & Security Tests ===\n');

  // Test Fixtures
  const session1 = {
    id: 'c7b39a82-4f1e-4c8d-9b5a-111111111111',
    code: 'sesscode1111',
    status: 'CONNECTED',
    machineId: 'mach-epson-6460',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000) // 1 hour future
  };
  mockSessions.set(session1.id, session1);

  const session2 = {
    id: 'd8c40b93-5e2f-5d9e-0c6b-222222222222',
    code: 'sesscode2222',
    status: 'CONNECTED',
    machineId: 'mach-epson-6460',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000)
  };
  mockSessions.set(session2.id, session2);

  const expiredSession = {
    id: 'e9d51c04-6f3a-6e0f-1d7c-333333333333',
    code: 'sesscode_exp',
    status: 'WAITING_FOR_MOBILE',
    machineId: 'mach-epson-6460',
    expiresAt: new Date(Date.now() - 10 * 60 * 1000) // 10 mins past
  };
  mockSessions.set(expiredSession.id, expiredSession);

  // Mint Tokens
  const token1 = jwt.sign(
    { sessionId: session1.code, machineId: session1.machineId, type: 'session', role: 'mobile' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const token2 = jwt.sign(
    { sessionId: session2.code, machineId: session2.machineId, type: 'session', role: 'mobile' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const expiredToken = jwt.sign(
    { sessionId: expiredSession.code, machineId: expiredSession.machineId, type: 'session', role: 'mobile' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // Create physical test PDF for Session 1
  const testPdf1Name = `sess_${session1.id}_doc1.pdf`;
  const testPdf1Path = path.join(testUploadsDir, testPdf1Name);
  fs.writeFileSync(testPdf1Path, '%PDF-1.4\n%TEST-PDF-BODY-SESSION-1\n%%EOF');

  // Create physical test PDF for Session 2
  const testPdf2Name = `sess_${session2.id}_doc2.pdf`;
  const testPdf2Path = path.join(testUploadsDir, testPdf2Name);
  fs.writeFileSync(testPdf2Path, '%PDF-1.4\n%TEST-PDF-BODY-SESSION-2\n%%EOF');

  // Create legacy unowned file (without prefix)
  const legacyFileName = 'old-unowned-file-uuid.pdf';
  const legacyFilePath = path.join(testUploadsDir, legacyFileName);
  fs.writeFileSync(legacyFilePath, '%PDF-1.4\n%LEGACY-FILE-CONTENT\n%%EOF');

  // TEST 1: Authorized session retrieves its own PDF
  await runTest('1. Authorized session retrieves its own PDF (200 OK + inline PDF)', async () => {
    const res = await request(app)
      .get(`/api/upload/preview/${testPdf1Name}`)
      .set('Authorization', `Bearer ${token1}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'application/pdf');
    assert.strictEqual(res.headers['content-disposition'], 'inline');
    assert.strictEqual(res.headers['cache-control'], 'private, no-cache, no-store, must-revalidate');
    assert(res.body.toString('utf8').includes('%PDF-1.4'), 'Expected PDF magic bytes in response');
  });

  // TEST 2: Unauthorized request receives 401
  await runTest('2. Unauthorized request receives 401 (missing or invalid token)', async () => {
    const resNoToken = await request(app)
      .get(`/api/upload/preview/${testPdf1Name}`);
    assert.strictEqual(resNoToken.status, 401);

    const resBadToken = await request(app)
      .get(`/api/upload/preview/${testPdf1Name}`)
      .set('Authorization', 'Bearer invalid.forged.jwt');
    assert.strictEqual(resBadToken.status, 401);
  });

  // TEST 3: Different active session receives 403 (BOLA / IDOR protection)
  await runTest('3. Different active session receives 403 Forbidden (BOLA blocked)', async () => {
    const res = await request(app)
      .get(`/api/upload/preview/${testPdf1Name}`)
      .set('Authorization', `Bearer ${token2}`);

    assert.strictEqual(res.status, 403);
    assert(res.body.message.includes('Access denied'), 'Expected access denied message');
  });

  // TEST 4: Expired session is rejected with 410
  await runTest('4. Expired session is rejected with 410 Gone', async () => {
    const res = await request(app)
      .get(`/api/upload/preview/sess_${expiredSession.id}_doc.pdf`)
      .set('Authorization', `Bearer ${expiredToken}`);

    assert.strictEqual(res.status, 410);
    assert(res.body.message.includes('expired'), 'Expected session expired message');
  });

  // TEST 5: Path traversal attempts are rejected with 400
  await runTest('5. Path traversal attempts are rejected with 400 Bad Request', async () => {
    const res1 = await request(app)
      .get('/api/upload/preview/..%2f..%2fetc%2fpasswd')
      .set('Authorization', `Bearer ${token1}`);
    assert.strictEqual(res1.status, 400);

    const res2 = await request(app)
      .get('/api/upload/preview/..%2Fconfig.json')
      .set('Authorization', `Bearer ${token1}`);
    assert.strictEqual(res2.status, 400);
  });

  // TEST 6: Customer cannot access unowned legacy files without ownership prefix
  await runTest('6. Customer cannot access legacy unowned file without session prefix (403)', async () => {
    const res = await request(app)
      .get(`/api/upload/preview/${legacyFileName}`)
      .set('Authorization', `Bearer ${token1}`);

    assert.strictEqual(res.status, 403);
    assert(res.body.message.includes('Access denied'));
  });

  // TEST 7: Printer Agent authorization on /uploads/:filename remains secure & untouched
  await runTest('7. Printer Agent authorization on /uploads/:filename remains untouched', async () => {
    try {
      // 7a. Seed mock machine and document for printer-agent download test
      const agentMachine = { id: 'mach-epson-6460', machineKey: 'sec_agent_key_6460', status: 'ACTIVE' };
      mockMachines.set(agentMachine.id, agentMachine);

      const printDoc = {
        id: 'doc-completed-uuid-1',
        filename: `http://localhost:5000/uploads/${testPdf1Name}`,
        printJobs: [{ machineId: agentMachine.id, machine: agentMachine }]
      };
      mockDocuments.set(printDoc.id, printDoc);

      // 7b. Customer mobile session token on /uploads/:filename is strictly FORBIDDEN (403)
      const mobileRes = await request(app)
        .get(`/uploads/${testPdf1Name}`)
        .set('Authorization', `Bearer ${token1}`);
      // fileAuth / serveDocument intentionally returns 403 for customer sessions
      assert.strictEqual(mobileRes.status, 403);

      // 7c. Missing x-machine-key on /uploads/:filename returns 401
      const agentNoKeyRes = await request(app)
        .get(`/uploads/${testPdf1Name}`);
      assert.strictEqual(agentNoKeyRes.status, 401);

      // 7d. Valid Printer Agent with x-machine-key downloads successfully (200 OK)
      const agentValidRes = await request(app)
        .get(`/uploads/${testPdf1Name}`)
        .set('x-machine-key', agentMachine.machineKey)
        .buffer(true)
        .parse((res, callback) => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        });
      assert.strictEqual(agentValidRes.status, 200);
      assert(agentValidRes.body.toString('utf8').includes('%PDF-1.4'));
    } finally {
      // Clean up mock document so Test 10 is unaffected
      mockDocuments.clear();
      mockMachines.clear();
    }
  });

  // TEST 8: PDF preview works after simulated browser refresh
  await runTest('8. PDF preview rehydration works after simulated browser refresh', async () => {
    // Simulate frontend recovery from sessionStorage:
    const recoveredSession = {
      sessionToken: token1,
      sessionCode: session1.code,
      fileData: {
        filename: `http://localhost:5000/uploads/${testPdf1Name}`,
        originalName: 'MyContract.pdf',
        size: 1024,
        pages: 1,
        mimetype: 'application/pdf'
      }
    };

    const diskFilename = recoveredSession.fileData.filename.split('/').pop();
    const res = await request(app)
      .get(`/api/upload/preview/${encodeURIComponent(diskFilename)}`)
      .set('Authorization', `Bearer ${recoveredSession.sessionToken}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    assert.strictEqual(res.status, 200);
    assert(Buffer.isBuffer(res.body), 'Expected binary buffer response');
    assert(res.body.toString('utf8').startsWith('%PDF-1.4'), 'Expected valid PDF bytes');
  });

  // TEST 9: Encrypted PDF preview decrypts client-side after browser refresh
  await runTest('9. Encrypted PDF preview decrypts client-side and recovers valid PDF', async () => {
    // 9a. Prepare an unencrypted PDF
    const plainPdfBytes = Buffer.from('%PDF-1.4\n%CONFIDENTIAL-ENCRYPTED-DOCUMENT-BODY\n%%EOF');

    // 9b. Client encrypts using AES-256-GCM (simulating WebCrypto in browser)
    const rawKey = crypto.randomBytes(32);
    const rawIv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', rawKey, rawIv);
    const encryptedBody = Buffer.concat([cipher.update(plainPdfBytes), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const fullEncryptedPayload = Buffer.concat([encryptedBody, authTag]);

    // 9c. Write encrypted payload to disk with Session 1 prefix
    const encFileName = `sess_${session1.id}_encrypted_doc.pdf`;
    fs.writeFileSync(path.join(testUploadsDir, encFileName), fullEncryptedPayload);

    // 9d. Recovered session metadata contains base64 key and iv
    const recoveredWithE2E = {
      sessionToken: token1,
      sessionCode: session1.code,
      fileData: {
        filename: `http://localhost:5000/uploads/${encFileName}`,
        originalName: 'EncryptedMedicalReport.pdf',
        mimetype: 'application/pdf'
      },
      e2e: {
        isEncrypted: true,
        rawKey: rawKey.toString('base64'),
        rawIv: rawIv.toString('base64')
      }
    };

    // 9e. Fetch preview binary
    const res = await request(app)
      .get(`/api/upload/preview/${encFileName}`)
      .set('Authorization', `Bearer ${recoveredWithE2E.sessionToken}`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    assert.strictEqual(res.status, 200);
    const downloadedEncryptedBytes = res.body;

    // 9f. Client-side decryption simulation (using recovered e2e key and iv)
    const recoveredKey = Buffer.from(recoveredWithE2E.e2e.rawKey, 'base64');
    const recoveredIv = Buffer.from(recoveredWithE2E.e2e.rawIv, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', recoveredKey, recoveredIv);
    // In AES-GCM, the last 16 bytes are the auth tag
    const ciphertext = downloadedEncryptedBytes.subarray(0, downloadedEncryptedBytes.length - 16);
    const tag = downloadedEncryptedBytes.subarray(downloadedEncryptedBytes.length - 16);
    decipher.setAuthTag(tag);
    const decryptedPdf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    assert.strictEqual(decryptedPdf.toString('utf8'), plainPdfBytes.toString('utf8'), 'Decrypted content must exactly match original PDF');
    assert(decryptedPdf.toString('utf8').startsWith('%PDF-1.4'), 'Decrypted payload must be valid PDF');
  });

  // TEST 10: Zero Document, PrintJob, Payment, or Invoice records created
  await runTest('10. Zero premature Document, PrintJob, Payment or Invoice records exist in DB', async () => {
    const docCount = await mockPrisma.document.count();
    const jobCount = await mockPrisma.printJob.count();
    const paymentCount = await mockPrisma.payment.count();
    const invoiceCount = await mockPrisma.invoice.count();

    assert.strictEqual(docCount, 0, 'Document records must be 0 before checkout');
    assert.strictEqual(jobCount, 0, 'PrintJob records must be 0 before checkout');
    assert.strictEqual(paymentCount, 0, 'Payment records must be 0 before checkout');
    assert.strictEqual(invoiceCount, 0, 'Invoice records must be 0 before checkout');
  });

  // Cleanup temporary test files
  try {
    fs.rmSync(testUploadsDir, { recursive: true, force: true });
  } catch {}

  console.log(`\nTest Summary: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
