/**
 * PRINTGO — PHASE 2 AUTOMATED TEST SUITE
 * Permanent Printer QR Backend Services, Lifecycle & API Security
 *
 * MANDATORY SAFETY ENFORCEMENT:
 * Strictly bound to printgo_disposable_target on port 5433 OR isolated in-memory deterministic fixture.
 * NEVER connects to Production or live Staging databases.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_phase2_isolated_testing';
process.env.PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || 'https://printgo.in';

const credsPath = path.resolve(__dirname, '../../.pg_credentials.local');
let prisma;
let isMocked = false;

// In-Memory collections for deterministic isolated testing when .pg_credentials.local is absent
const mockCompanies = new Map();
const mockMachines = new Map();
const mockPrinterQrs = new Map();
const mockSessions = new Map();

if (fs.existsSync(credsPath)) {
  const creds = fs.readFileSync(credsPath, 'utf8');
  const pass = creds.match(/POSTGRES_PASSWORD=(.*)/)[1].trim();
  const targetUrl = `postgresql://postgres:${encodeURIComponent(pass)}@localhost:5433/printgo_disposable_target?schema=public`;
  process.env.DATABASE_URL = targetUrl;
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: targetUrl } } });
} else {
  isMocked = true;

  const mockPrisma = {
    $isMock: true,
    $queryRawUnsafe: async (sql, ...params) => {
      if (sql.includes('current_database()')) {
        return [{
          current_database: 'printgo_disposable_target',
          inet_server_port: 5433,
          version: 'PostgreSQL 17.4 (Mocked In-Memory Isolated Target)'
        }];
      }

      // Handle locking queries for PrinterQr
      if (sql.includes('FROM "PrinterQr" pq')) {
        if (sql.includes('WHERE pq.id = $1')) {
          const id = params[0];
          const qr = mockPrinterQrs.get(id);
          if (!qr) return [];
          const machine = qr.machineId ? mockMachines.get(qr.machineId) : null;
          return [{
            ...qr,
            machine_company_id: machine ? machine.companyId : null
          }];
        }
        if (sql.includes('WHERE pq."publicCode" = $1')) {
          const code = params[0];
          let foundQr = null;
          for (const q of mockPrinterQrs.values()) {
            if (q.publicCode === code) {
              foundQr = q;
              break;
            }
          }
          if (!foundQr) return [];
          const machine = foundQr.machineId ? mockMachines.get(foundQr.machineId) : null;
          return [{
            ...foundQr,
            machine_id: machine ? machine.id : null,
            machine_name: machine ? machine.name : null,
            machine_printer_model: machine ? machine.printerModel : null,
            machine_location: machine ? machine.location : null,
            machine_status: machine ? machine.status : null
          }];
        }
      }
      return [];
    },
    $transaction: async (callbackOrArray) => {
      if (typeof callbackOrArray === 'function') {
        return callbackOrArray(mockPrisma);
      }
      return Promise.all(callbackOrArray);
    },
    $disconnect: async () => {},

    company: {
      upsert: async ({ where, create, update }) => {
        let found = null;
        if (where.contactEmail) {
          for (const c of mockCompanies.values()) {
            if (c.contactEmail === where.contactEmail) {
              found = c;
              break;
            }
          }
        }
        if (found) {
          Object.assign(found, update || {});
          return { ...found };
        }
        const created = { id: crypto.randomUUID(), ...(create || {}) };
        mockCompanies.set(created.id, created);
        return { ...created };
      },
      deleteMany: async ({ where } = {}) => {
        let count = 0;
        if (where?.contactEmail?.in) {
          for (const [id, c] of mockCompanies.entries()) {
            if (where.contactEmail.in.includes(c.contactEmail)) {
              mockCompanies.delete(id);
              count++;
            }
          }
        }
        return { count };
      }
    },

    machine: {
      upsert: async ({ where, create, update }) => {
        let found = null;
        if (where.machineKey) {
          for (const m of mockMachines.values()) {
            if (m.machineKey === where.machineKey) {
              found = m;
              break;
            }
          }
        }
        if (found) {
          Object.assign(found, update || {});
          return { ...found };
        }
        const created = {
          id: crypto.randomUUID(),
          lastOnline: new Date(),
          printerStatuses: [
            {
              isOnline: true,
              paperStatus: 'OK',
              jamStatus: false,
              timestamp: new Date()
            }
          ],
          ...(create || {})
        };
        mockMachines.set(created.id, created);
        return { ...created };
      },
      findUnique: async ({ where, include }) => {
        let machine = null;
        if (where.id) machine = mockMachines.get(where.id);
        if (!machine && where.machineKey) {
          for (const m of mockMachines.values()) {
            if (m.machineKey === where.machineKey) {
              machine = m;
              break;
            }
          }
        }
        if (!machine) return null;
        const res = { ...machine };
        if (include?.company && res.companyId) {
          res.company = mockCompanies.get(res.companyId) || null;
        }
        if (include?.printerStatuses) {
          res.printerStatuses = machine.printerStatuses || [];
        }
        return res;
      },
      findFirst: async ({ where, include } = {}) => {
        for (const m of mockMachines.values()) {
          if (where?.status && m.status !== where.status) continue;
          const res = { ...m };
          if (include?.company && res.companyId) {
            res.company = mockCompanies.get(res.companyId) || null;
          }
          if (include?.printerStatuses) {
            res.printerStatuses = m.printerStatuses || [];
          }
          return res;
        }
        return null;
      },
      deleteMany: async ({ where } = {}) => {
        let count = 0;
        if (where?.machineKey?.in) {
          for (const [id, m] of mockMachines.entries()) {
            if (where.machineKey.in.includes(m.machineKey)) {
              mockMachines.delete(id);
              count++;
            }
          }
        }
        return { count };
      }
    },

    printerQr: {
      create: async ({ data }) => {
        const qr = {
          id: crypto.randomUUID(),
          status: 'ACTIVE',
          label: null,
          revokedReason: null,
          revokedBy: null,
          revokedAt: null,
          replacementQrId: null,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        mockPrinterQrs.set(qr.id, qr);
        return { ...qr };
      },
      findFirst: async ({ where, include }) => {
        for (const q of mockPrinterQrs.values()) {
          if (where?.machineId && q.machineId !== where.machineId) continue;
          if (where?.status && q.status !== where.status) continue;
          const res = { ...q };
          if (include?.machine && res.machineId) {
            res.machine = mockMachines.get(res.machineId) || null;
          }
          return res;
        }
        return null;
      },
      findUnique: async ({ where, include }) => {
        let qr = null;
        if (where.id) qr = mockPrinterQrs.get(where.id);
        if (!qr && where.publicCode) {
          for (const q of mockPrinterQrs.values()) {
            if (q.publicCode === where.publicCode) {
              qr = q;
              break;
            }
          }
        }
        if (!qr) return null;
        const res = { ...qr };
        if (include?.machine && res.machineId) {
          const m = mockMachines.get(res.machineId);
          res.machine = m ? { ...m } : null;
          if (include.machine.include?.company && res.machine?.companyId) {
            res.machine.company = mockCompanies.get(res.machine.companyId) || null;
          }
        }
        return res;
      },
      findMany: async ({ where, include, orderBy, skip = 0, take = 100 }) => {
        let list = Array.from(mockPrinterQrs.values());
        if (where?.machineId) {
          list = list.filter(q => q.machineId === where.machineId);
        }
        if (where?.status) {
          list = list.filter(q => q.status === where.status);
        }
        if (where?.machine?.companyId) {
          list = list.filter(q => {
            const m = mockMachines.get(q.machineId);
            return m && m.companyId === where.machine.companyId;
          });
        }
        if (where?.search) {
          const s = where.search.toLowerCase();
          list = list.filter(q => {
            const m = mockMachines.get(q.machineId);
            return (
              (q.publicCode && q.publicCode.toLowerCase().includes(s)) ||
              (q.label && q.label.toLowerCase().includes(s)) ||
              (m && m.name && m.name.toLowerCase().includes(s))
            );
          });
        }
        list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        return list.slice(skip, skip + take).map(q => {
          const res = { ...q };
          if (include?.machine && res.machineId) {
            const m = mockMachines.get(res.machineId);
            res.machine = m
              ? {
                  id: m.id,
                  name: m.name,
                  location: m.location,
                  status: m.status,
                  printerModel: m.printerModel,
                  companyId: m.companyId
                }
              : null;
          }
          if (include?._count?.select?.sessions) {
            let sessionCount = 0;
            for (const s of mockSessions.values()) {
              if (s.printerQrId === q.id) sessionCount++;
            }
            res._count = { sessions: sessionCount };
          }
          return res;
        });
      },
      count: async ({ where } = {}) => {
        let list = Array.from(mockPrinterQrs.values());
        if (where?.machineId) list = list.filter(q => q.machineId === where.machineId);
        if (where?.status) list = list.filter(q => q.status === where.status);
        if (where?.machine?.companyId) {
          list = list.filter(q => {
            const m = mockMachines.get(q.machineId);
            return m && m.companyId === where.machine.companyId;
          });
        }
        return list.length;
      },
      update: async ({ where, data }) => {
        const qr = mockPrinterQrs.get(where.id);
        if (!qr) throw new Error('Printer QR not found');
        Object.assign(qr, data, { updatedAt: new Date() });
        return { ...qr };
      },
      deleteMany: async ({ where } = {}) => {
        let count = 0;
        if (where?.id?.in) {
          for (const id of where.id.in) {
            if (mockPrinterQrs.delete(id)) count++;
          }
        }
        return { count };
      }
    },

    printPricingProfile: {
      findFirst: async () => null,
      findUnique: async () => null,
    },

    session: {
      create: async ({ data }) => {
        const session = {
          id: crypto.randomUUID(),
          ...data,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        mockSessions.set(session.code, session);
        mockSessions.set(session.id, session);
        return { ...session };
      },
      findUnique: async ({ where }) => {
        for (const s of mockSessions.values()) {
          if (where.id && s.id === where.id) return { ...s };
          if (where.code && s.code === where.code) return { ...s };
        }
        return null;
      },
      update: async ({ where, data }) => {
        let session = null;
        for (const s of mockSessions.values()) {
          if (where.id && s.id === where.id) {
            session = s;
            break;
          }
          if (where.code && s.code === where.code) {
            session = s;
            break;
          }
        }
        if (!session) throw new Error('Session not found');
        Object.assign(session, data, { updatedAt: new Date() });
        return { ...session };
      },
      deleteMany: async ({ where } = {}) => {
        let count = 0;
        if (where?.printerQrId?.in) {
          for (const [key, s] of mockSessions.entries()) {
            if (where.printerQrId.in.includes(s.printerQrId)) {
              mockSessions.delete(key);
              count++;
            }
          }
        }
        return { count };
      }
    }
  };

  prisma = mockPrisma;

  // Intercept shared utils/prisma module in require.cache and Jest registry
  const prismaModulePath = path.resolve(__dirname, '../src/utils/prisma');
  try {
    const resolved = require.resolve(prismaModulePath);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: mockPrisma
    };
  } catch {}

  if (typeof jest !== 'undefined') {
    jest.mock('../src/utils/prisma', () => mockPrisma);
  }
}

// Import services after prisma has been configured/mocked
const printerQrService = require('../src/services/printerQr.service');
const authController = require('../src/modules/auth/auth.controller');
const printerQrAdminController = require('../src/modules/admin/printerQr.admin.controller');

let companyA, companyB;
let userSuperadmin, userFranchiseeA, userFranchiseeB;
let machineA, machineA2, machineRevoke, machineB, machineSuspended;
const testQrIds = [];
let activeQrA = null;
let session1Result = null;
let qrToRotate = null;
let replacementResult = null;

const assert = (condition, msg) => {
  if (!condition) throw new Error(msg || 'Assertion failed');
};

async function setupDatabase() {
  const meta = await prisma.$queryRawUnsafe('SELECT current_database(), inet_server_port(), version()');
  const dbName = meta[0].current_database;
  const dbPort = meta[0].inet_server_port;

  if (dbName !== 'printgo_disposable_target') {
    throw new Error('FATAL SAFETY VIOLATION: Database is not printgo_disposable_target! Aborting immediately.');
  }
  if (dbPort !== 5433) {
    throw new Error('FATAL SAFETY VIOLATION: Port is not 5433! Aborting immediately.');
  }

  companyA = await prisma.company.upsert({
    where: { contactEmail: 'shop_a_franchisee@test.com' },
    update: {},
    create: { name: 'Shop Alpha Franchisee', contactEmail: 'shop_a_franchisee@test.com' }
  });

  companyB = await prisma.company.upsert({
    where: { contactEmail: 'shop_b_franchisee@test.com' },
    update: {},
    create: { name: 'Shop Beta Franchisee', contactEmail: 'shop_b_franchisee@test.com' }
  });

  userSuperadmin = { id: 'usr_superadmin', role: 'SUPERADMIN', email: 'superadmin@printgo.in' };
  userFranchiseeA = { id: 'usr_franchisee_a', role: 'FRANCHISEE', companyId: companyA.id, email: 'owner@shopa.com' };
  userFranchiseeB = { id: 'usr_franchisee_b', role: 'FRANCHISEE', companyId: companyB.id, email: 'owner@shopb.com' };

  machineA = await prisma.machine.upsert({
    where: { machineKey: 'test_machine_key_phase2_a' },
    update: { companyId: companyA.id, status: 'ACTIVE', lastOnline: new Date() },
    create: {
      name: 'Printer Alpha Active',
      location: 'Counter 1',
      machineKey: 'test_machine_key_phase2_a',
      status: 'ACTIVE',
      lastOnline: new Date(),
      printerModel: 'Canon G3010',
      companyId: companyA.id
    }
  });

  await prisma.printerStatus.deleteMany({ where: { machineId: machineA.id } });
  await prisma.printerStatus.create({
    data: {
      machineId: machineA.id,
      isOnline: true,
      paperStatus: 'OK',
      tonerStatus: 'OK',
      jamStatus: false,
      timestamp: new Date()
    }
  });

  machineA2 = await prisma.machine.upsert({
    where: { machineKey: 'test_machine_key_phase2_a2' },
    update: { companyId: companyA.id, status: 'ACTIVE' },
    create: {
      name: 'Printer Alpha 2 Active',
      location: 'Counter 2',
      machineKey: 'test_machine_key_phase2_a2',
      status: 'ACTIVE',
      printerModel: 'Canon G3010',
      companyId: companyA.id
    }
  });

  machineRevoke = await prisma.machine.upsert({
    where: { machineKey: 'test_machine_key_phase2_revoke' },
    update: { companyId: companyA.id, status: 'ACTIVE' },
    create: {
      name: 'Printer Revoke Test',
      location: 'Counter Revoke',
      machineKey: 'test_machine_key_phase2_revoke',
      status: 'ACTIVE',
      printerModel: 'Epson EcoTank',
      companyId: companyA.id
    }
  });

  machineB = await prisma.machine.upsert({
    where: { machineKey: 'test_machine_key_phase2_b' },
    update: { companyId: companyB.id, status: 'ACTIVE' },
    create: {
      name: 'Printer Beta Active',
      location: 'Counter 2',
      machineKey: 'test_machine_key_phase2_b',
      status: 'ACTIVE',
      printerModel: 'HP LaserJet Pro',
      companyId: companyB.id
    }
  });

  machineSuspended = await prisma.machine.upsert({
    where: { machineKey: 'test_machine_key_phase2_suspended' },
    update: { status: 'SUSPENDED' },
    create: {
      name: 'Printer Suspended',
      location: 'Back Office',
      machineKey: 'test_machine_key_phase2_suspended',
      status: 'SUSPENDED',
      companyId: companyA.id
    }
  });

  // Seed legacy demo machine and session for F1
  const legacyMachineId = 'a8b6164a-1c3f-46ab-b8ef-5cb2c3212d28';
  mockMachines.set(legacyMachineId, {
    id: legacyMachineId,
    name: 'Epson L6460 Counter Printer',
    location: 'Counter 1',
    printerModel: 'EPSON L6460 Series',
    status: 'ACTIVE',
    companyId: companyA.id,
    lastOnline: new Date(),
    printerStatuses: [
      {
        isOnline: true,
        paperStatus: 'OK',
        jamStatus: false,
        timestamp: new Date()
      }
    ]
  });

  await prisma.machine.upsert({
    where: { id: legacyMachineId },
    update: { status: 'ACTIVE', lastOnline: new Date(), companyId: companyA.id },
    create: {
      id: legacyMachineId,
      name: 'Epson L6460 Counter Printer',
      location: 'Counter 1',
      machineKey: 'legacy_epson_demo_key',
      printerModel: 'EPSON L6460 Series',
      status: 'ACTIVE',
      lastOnline: new Date(),
      companyId: companyA.id
    }
  });

  await prisma.session.upsert({
    where: { code: 'EPSON-DEMO-01' },
    update: { machineId: legacyMachineId, status: 'WAITING_FOR_MOBILE', expiresAt: new Date(Date.now() + 3600000) },
    create: {
      code: 'EPSON-DEMO-01',
      machineId: legacyMachineId,
      status: 'WAITING_FOR_MOBILE',
      expiresAt: new Date(Date.now() + 3600000)
    }
  });

  const demoSession = {
    id: 'sess_epson_demo_1',
    code: 'EPSON-DEMO-01',
    machineId: legacyMachineId,
    status: 'WAITING_FOR_MOBILE',
    expiresAt: new Date(Date.now() + 3600000)
  };
  mockSessions.set(demoSession.id, demoSession);
  mockSessions.set(demoSession.code, demoSession);
}

async function cleanupDatabase() {
  await prisma.session.deleteMany({
    where: { printerQrId: { in: testQrIds } }
  });
  await prisma.printerQr.deleteMany({
    where: { id: { in: testQrIds } }
  });
  await prisma.machine.deleteMany({
    where: {
      machineKey: {
        in: [
          'test_machine_key_phase2_a',
          'test_machine_key_phase2_a2',
          'test_machine_key_phase2_revoke',
          'test_machine_key_phase2_b',
          'test_machine_key_phase2_suspended'
        ]
      }
    }
  });
  await prisma.company.deleteMany({
    where: { contactEmail: { in: ['shop_a_franchisee@test.com', 'shop_b_franchisee@test.com'] } }
  });
  await prisma.$disconnect();
}

// ----------------------------------------------------------------------------
// TEST DEFINITIONS (A1 through F2)
// ----------------------------------------------------------------------------

async function testA1() {
  const token = printerQrService.generateSecurePublicCode();
  assert(token.startsWith('pq_'), 'Token must start with pq_ prefix');
  const rawPart = token.slice(3);
  assert(rawPart.length >= 40, 'Token raw part must have at least 32 bytes of Base64URL entropy (>= 43 chars)');
  assert(/^[a-zA-Z0-9_-]+$/.test(rawPart), 'Token must be strictly URL-safe');
}

async function testA2() {
  const set = new Set();
  const count = 1000;
  for (let i = 0; i < count; i++) {
    const code = printerQrService.generateSecurePublicCode();
    assert(!set.has(code), `Collision detected on iteration ${i} for code ${code}`);
    set.add(code);
  }
  assert(set.size === count, 'All 1,000 tokens must be strictly unique');
}

async function testA3() {
  const originalEnv = process.env.NODE_ENV;
  const originalUrl = process.env.PUBLIC_APP_URL;

  try {
    process.env.NODE_ENV = 'production';

    // Test localhost rejection
    process.env.PUBLIC_APP_URL = 'http://localhost:5173';
    let threwLocalhost = false;
    try {
      printerQrService.getPublicQrUrl('test_code');
    } catch (err) {
      threwLocalhost = true;
    }
    assert(threwLocalhost, 'Production must reject http://localhost');

    // Test private LAN IP rejection
    process.env.PUBLIC_APP_URL = 'https://192.168.1.5:5173';
    let threwPrivateIp = false;
    try {
      printerQrService.getPublicQrUrl('test_code');
    } catch (err) {
      threwPrivateIp = true;
    }
    assert(threwPrivateIp, 'Production must reject private LAN IPs even with HTTPS');

    // Test valid public HTTPS URL
    process.env.PUBLIC_APP_URL = 'https://printgo.in';
    const validUrl = printerQrService.getPublicQrUrl('test_code_123');
    assert(validUrl === 'https://printgo.in/p/test_code_123', 'Valid public HTTPS URL must resolve correctly');

    // Test missing URL in production (fails closed)
    delete process.env.PUBLIC_APP_URL;
    delete process.env.PUBLIC_FRONTEND_URL;
    delete process.env.FRONTEND_URL;
    let threwMissing = false;
    try {
      printerQrService.getPublicQrUrl('test_code');
    } catch (err) {
      threwMissing = true;
    }
    assert(threwMissing, 'Production must fail closed if PUBLIC_APP_URL is missing');
  } finally {
    process.env.NODE_ENV = originalEnv;
    process.env.PUBLIC_APP_URL = originalUrl || 'https://printgo.in';
  }
}

async function testB1() {
  activeQrA = await printerQrService.generatePrinterQr(machineA.id, { label: 'Front Counter Master' }, userSuperadmin);
  testQrIds.push(activeQrA.id);

  assert(activeQrA.id, 'Created QR must have a database UUID');
  assert(activeQrA.publicCode.startsWith('pq_'), 'Created QR must have secure pq_ code');
  assert(activeQrA.status === 'ACTIVE', 'Created QR must have status ACTIVE');
  assert(activeQrA.machineId === machineA.id, 'QR must be bound to Printer A');
  assert(activeQrA.targetUrl.includes(activeQrA.publicCode), 'Target URL must include public code');
}

async function testB2() {
  const qrFranchiseeA = await printerQrService.generatePrinterQr(machineA2.id, { label: 'Side Pedestal' }, userFranchiseeA);
  testQrIds.push(qrFranchiseeA.id);

  assert(qrFranchiseeA.machineId === machineA2.id, 'Franchisee must successfully generate QR for owned machine');
}

async function testB3() {
  let accessDenied = false;
  try {
    await printerQrService.generatePrinterQr(machineA.id, { label: 'Unauthorized Attempt' }, userFranchiseeB);
  } catch (err) {
    if (err.statusCode === 403 || err.message.includes('Access denied')) {
      accessDenied = true;
    }
  }
  assert(accessDenied, 'Franchisee B must be rejected when attempting to manage Franchisee A machine');
}

async function testB4() {
  let notFound = false;
  try {
    await printerQrService.generatePrinterQr('00000000-0000-0000-0000-000000000000', {}, userSuperadmin);
  } catch (err) {
    if (err.statusCode === 404) notFound = true;
  }
  assert(notFound, 'Non-existent machine must return 404');
}

async function testB5() {
  let suspendedBlocked = false;
  try {
    await printerQrService.generatePrinterQr(machineSuspended.id, {}, userSuperadmin);
  } catch (err) {
    if (err.statusCode === 400 || err.message.includes('suspended')) suspendedBlocked = true;
  }
  assert(suspendedBlocked, 'Suspended machine must be rejected for QR generation');
}

async function testC1() {
  session1Result = await printerQrService.resolvePrinterQr(activeQrA.publicCode);

  assert(session1Result.success === true, 'Session resolution must return success: true');
  assert(session1Result.sessionCode, 'Must return ephemeral sessionCode');
  assert(session1Result.sessionToken, 'Must return signed sessionToken');
  assert(session1Result.printer.name === machineA.name, 'Must return target printer name');
  assert(session1Result.printer.isOnline === true, 'Printer must be reported online');

  const dbSession = await prisma.session.findUnique({ where: { code: session1Result.sessionCode } });
  assert(dbSession, 'Session must exist in database');
  assert(dbSession.machineId === machineA.id, 'Session machineId must match target printer');
  assert(dbSession.printerQrId === activeQrA.id, 'Session must be linked to printerQrId');

  const ttlMins = (new Date(dbSession.expiresAt).getTime() - Date.now()) / (60 * 1000);
  assert(ttlMins >= 58 && ttlMins <= 62, 'Session TTL must be approximately 60 minutes');
}

async function testC2() {
  const session2Result = await printerQrService.resolvePrinterQr(activeQrA.publicCode);

  assert(session2Result.sessionCode !== session1Result.sessionCode, 'Second scan must produce distinct sessionCode');
  assert(session2Result.sessionToken !== session1Result.sessionToken, 'Second scan must produce distinct sessionToken');

  const dbSession2 = await prisma.session.findUnique({ where: { code: session2Result.sessionCode } });
  assert(dbSession2.machineId === machineA.id, 'Second session must still bind to Printer A');
  assert(dbSession2.printerQrId === activeQrA.id, 'Second session must link to same physical QR');
}

async function testC3() {
  const decoded = jwt.verify(session1Result.sessionToken, process.env.JWT_SECRET);
  assert(decoded.sessionId === session1Result.sessionCode, 'JWT sessionId must match sessionCode');
  assert(decoded.machineId === machineA.id, 'JWT machineId must match target printer');
  assert(decoded.type === 'session', 'JWT type must be session');
  assert(decoded.role === 'mobile', 'JWT role must be mobile');
}

async function testC4() {
  let notFound = false;
  try {
    await printerQrService.resolvePrinterQr('pq_completely_unknown_token_9999');
  } catch (err) {
    if (err.statusCode === 404) notFound = true;
  }
  assert(notFound, 'Unknown public code must return 404');
}

async function testD1() {
  qrToRotate = await printerQrService.generatePrinterQr(machineRevoke.id, { label: 'To Be Revoked' }, userSuperadmin);
  testQrIds.push(qrToRotate.id);

  let emptyBlocked = false;
  try {
    await printerQrService.revokePrinterQr(qrToRotate.id, '', userSuperadmin);
  } catch (err) {
    if (err.statusCode === 400) emptyBlocked = true;
  }
  assert(emptyBlocked, 'Empty revocation reason must be rejected');

  let shortBlocked = false;
  try {
    await printerQrService.revokePrinterQr(qrToRotate.id, 'too short', userSuperadmin);
  } catch (err) {
    if (err.statusCode === 400) shortBlocked = true;
  }
  assert(shortBlocked, 'Short revocation reason (< 10 chars) must be rejected');
}

async function testD2() {
  const validReason = 'Physical flyer was damaged by spill and replaced';
  const revoked = await printerQrService.revokePrinterQr(qrToRotate.id, validReason, userSuperadmin);

  assert(revoked.status === 'REVOKED', 'Status must be updated to REVOKED');
  assert(revoked.revokedReason === validReason, 'Revoked reason must be stored in database');
  assert(revoked.revokedBy === userSuperadmin.id, 'Operator ID must be recorded');
  assert(revoked.revokedAt, 'Timestamp must be recorded');

  const dbQr = await prisma.printerQr.findUnique({ where: { id: qrToRotate.id } });
  assert(dbQr.status === 'REVOKED', 'Database record must show REVOKED');
}

async function testD3() {
  let goneCaught = false;
  let goneMessage = '';
  try {
    await printerQrService.resolvePrinterQr(qrToRotate.publicCode);
  } catch (err) {
    if (err.statusCode === 410) {
      goneCaught = true;
      goneMessage = err.message;
    }
  }
  assert(goneCaught, 'Scanning revoked QR must throw HTTP 410');
  assert(goneMessage.includes('revoked'), 'Error message must inform customer the QR was revoked');
}

async function testD4() {
  const qrToReplace = await printerQrService.generatePrinterQr(machineB.id, { label: 'Shop B Old Counter' }, userSuperadmin);
  testQrIds.push(qrToReplace.id);

  const replacementReason = 'Routine monthly security token rotation for Counter 2';
  replacementResult = await printerQrService.replacePrinterQr(qrToReplace.id, { replacementReason }, userSuperadmin);
  testQrIds.push(replacementResult.newQr.id);

  assert(replacementResult.archivedOldQr.status === 'REPLACED', 'Old QR must transition to REPLACED');
  assert(replacementResult.archivedOldQr.revokedReason === replacementReason, 'Old QR must store rotation reason');

  assert(replacementResult.newQr.status === 'ACTIVE', 'New QR must be ACTIVE');
  assert(replacementResult.newQr.publicCode !== qrToReplace.publicCode, 'New QR must have a completely distinct token');
  assert(replacementResult.newQr.machineId === machineB.id, 'New QR must bind to the same machine');

  let oldCodeBlocked = false;
  try {
    await printerQrService.resolvePrinterQr(qrToReplace.publicCode);
  } catch (err) {
    if (err.statusCode === 410 && err.message.includes('replaced')) oldCodeBlocked = true;
  }
  assert(oldCodeBlocked, 'Old replaced QR code must reject scans with HTTP 410');

  const newScan = await printerQrService.resolvePrinterQr(replacementResult.newQr.publicCode);
  assert(newScan.success === true, 'New rotated QR code must resolve successfully');
  assert(newScan.printer.name === machineB.name, 'New QR must correctly route to Printer B');
}

async function testE1() {
  const superList = await printerQrService.listPrinterQrs(userSuperadmin, {});
  assert(superList.qrs.length >= 2, 'Superadmin must see all active QRs');

  const franchAList = await printerQrService.listPrinterQrs(userFranchiseeA, {});
  const allBelongToA = franchAList.qrs.every(q => q.machine.companyId === companyA.id);
  assert(allBelongToA, 'Franchisee A list must strictly contain only machines from Company A');

  const franchBList = await printerQrService.listPrinterQrs(userFranchiseeB, {});
  const allBelongToB = franchBList.qrs.every(q => q.machine.companyId === companyB.id);
  assert(allBelongToB, 'Franchisee B list must strictly contain only machines from Company B');
}

async function testE2() {
  const req = {
    params: { id: machineB.id },
    user: userSuperadmin
  };
  let jsonResult = null;
  const res = {
    status: (code) => {
      assert(code === 200, 'Ledger endpoint must return HTTP 200');
      return {
        json: (data) => {
          jsonResult = data;
        }
      };
    }
  };
  const next = (err) => {
    if (err) throw err;
  };

  await printerQrAdminController.getMachineQrLedger(req, res, next);
  assert(jsonResult && jsonResult.success === true, 'Ledger must return success: true');
  assert(jsonResult.data.activeQr.publicCode === replacementResult.newQr.publicCode, 'Active QR must match newly rotated QR');
  assert(jsonResult.data.history.length >= 1, 'History must contain the replaced QR');
}

async function testF1() {
  const req = {
    body: { sessionCode: 'EPSON-DEMO-01' }
  };
  let jsonResult = null;
  const res = {
    status: (code) => {
      assert(code === 200, 'Legacy join must return 200');
      return {
        json: (data) => {
          jsonResult = data;
        }
      };
    }
  };
  const next = (err) => {
    if (err) throw err;
  };

  await authController.joinSession(req, res, next);
  assert(jsonResult && jsonResult.success === true, 'Legacy join must succeed');
  assert(jsonResult.sessionToken, 'Must return sessionToken');
  assert(jsonResult.machineId === 'a8b6164a-1c3f-46ab-b8ef-5cb2c3212d28', 'Must resolve to Epson L6460');
}

async function testF2() {
  const info = await printerQrService.getPublicPrinterQrInfo(activeQrA.publicCode);
  assert(info.success === true, 'Pre-scan must return success');
  assert(info.printer.name === machineA.name, 'Must return printer name');
  assert(info.printer.model === machineA.printerModel, 'Must return printer model');
  assert(!info.machineId, 'Must NOT expose internal machine UUID');
  assert(!info.machineKey, 'Must NOT expose agent machineKey');
}

// ----------------------------------------------------------------------------
// TEST RUNNER ADAPTER: JEST AND STANDALONE NODE SUPPORT
// ----------------------------------------------------------------------------

if (typeof describe === 'function' && typeof it === 'function') {
  describe('PRINTGO — PHASE 2 PERMANENT PRINTER QR TEST SUITE', () => {
    beforeAll(async () => {
      await setupDatabase();
    }, 30000);

    afterAll(async () => {
      await cleanupDatabase();
    }, 30000);

    describe('GROUP A: TOKEN SECURITY & PUBLIC URL VALIDATION', () => {
      it('A1: Token format and cryptographic entropy', async () => {
        await testA1();
      });
      it('A2: High-entropy uniqueness (1,000 generated tokens without collision)', async () => {
        await testA2();
      });
      it('A3: URL validation enforces HTTPS and rejects private IP in production', async () => {
        await testA3();
      });
    });

    describe('GROUP B: DEDICATED QR GENERATION & TENANT BINDING', () => {
      it('B1: Superadmin generates active dedicated QR for Printer A', async () => {
        await testB1();
      });
      it('B2: Franchisee A generates dedicated QR for own Printer A2', async () => {
        await testB2();
      });
      it('B3: Tenant isolation: Franchisee B CANNOT generate QR for Franchisee A printer', async () => {
        await testB3();
      });
      it('B4: Cannot generate QR for non-existent machine (404)', async () => {
        await testB4();
      });
      it('B5: Cannot generate QR for suspended machine (400)', async () => {
        await testB5();
      });
    });

    describe('GROUP C: CUSTOMER DYNAMIC SESSION RESOLUTION', () => {
      it('C1: Customer scans active QR: creates fresh 60-minute session', async () => {
        await testC1();
      });
      it('C2: Next customer scans SAME physical QR: receives completely fresh session', async () => {
        await testC2();
      });
      it('C3: Session JWT token verification and payload integrity', async () => {
        await testC3();
      });
      it('C4: Resolving non-existent QR code returns 404', async () => {
        await testC4();
      });
    });

    describe('GROUP D: QR ROTATION, REVOCATION & AUDIT LIFECYCLE', () => {
      it('D1: Revocation requires meaningful reason (>= 10 chars)', async () => {
        await testD1();
      });
      it('D2: Successful QR revocation with audit metadata', async () => {
        await testD2();
      });
      it('D3: Scanning a REVOKED QR code throws HTTP 410 Gone', async () => {
        await testD3();
      });
      it('D4: QR replacement rotates token atomically and marks old as REPLACED', async () => {
        await testD4();
      });
    });

    describe('GROUP E: ADMIN API ENDPOINTS & ROLE AUTHORIZATION', () => {
      it('E1: List QRs: Superadmin sees all; Franchisee scoped to company', async () => {
        await testE1();
      });
      it('E2: Machine QR ledger endpoint returns active QR and historical records', async () => {
        await testE2();
      });
    });

    describe('GROUP F: LEGACY COMPATIBILITY & REGRESSION', () => {
      it('F1: Legacy session join (/api/auth/session/join) remains 100% functional', async () => {
        await testF1();
      });
      it('F2: Public pre-scan metadata endpoint returns safe info without secrets', async () => {
        await testF2();
      });
    });
  });
} else {
  // Standalone node execution
  async function runTestSuite() {
    console.log('======================================================================');
    console.log('PRINTGO — PHASE 2 PERMANENT PRINTER QR TEST SUITE');
    console.log('Mode: Standalone Node Runner');
    console.log('======================================================================\n');

    await setupDatabase();
    console.log('Database verification passed.\n');

    let passed = 0;
    let failed = 0;
    const allTests = [
      ['A1: Token format and cryptographic entropy', testA1],
      ['A2: High-entropy uniqueness (1,000 generated tokens without collision)', testA2],
      ['A3: URL validation enforces HTTPS and rejects private IP in production', testA3],
      ['B1: Superadmin generates active dedicated QR for Printer A', testB1],
      ['B2: Franchisee A generates dedicated QR for own Printer A2', testB2],
      ['B3: Tenant isolation: Franchisee B CANNOT generate QR for Franchisee A printer', testB3],
      ['B4: Cannot generate QR for non-existent machine (404)', testB4],
      ['B5: Cannot generate QR for suspended machine (400)', testB5],
      ['C1: Customer scans active QR: creates fresh 60-minute session', testC1],
      ['C2: Next customer scans SAME physical QR: receives completely fresh session', testC2],
      ['C3: Session JWT token verification and payload integrity', testC3],
      ['C4: Resolving non-existent QR code returns 404', testC4],
      ['D1: Revocation requires meaningful reason (>= 10 chars)', testD1],
      ['D2: Successful QR revocation with audit metadata', testD2],
      ['D3: Scanning a REVOKED QR code throws HTTP 410 Gone', testD3],
      ['D4: QR replacement rotates token atomically and marks old as REPLACED', testD4],
      ['E1: List QRs: Superadmin sees all; Franchisee scoped to company', testE1],
      ['E2: Machine QR ledger endpoint returns active QR and historical records', testE2],
      ['F1: Legacy session join (/api/auth/session/join) remains 100% functional', testF1],
      ['F2: Public pre-scan metadata endpoint returns safe info without secrets', testF2]
    ];

    for (const [name, fn] of allTests) {
      try {
        await fn();
        console.log(`✅ PASS: ${name}`);
        passed++;
      } catch (e) {
        console.error(`❌ FAIL: ${name}`);
        console.error(`   Details: ${e.message}\n`);
        failed++;
      }
    }

    await cleanupDatabase();

    console.log('\n======================================================================');
    console.log(`PHASE 2 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
    console.log('======================================================================');

    if (failed > 0) {
      process.exit(1);
    }
  }

  runTestSuite().catch(err => {
    console.error('\nUNHANDLED EXCEPTION IN PHASE 2 TEST SUITE:', err);
    process.exit(1);
  });
}
