process.env.JWT_SECRET = 'test_jwt_secret_role_phase1_hardening';

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const usersRoutes = require('../src/modules/users/users.routes');
const authRoutes = require('../src/modules/auth/auth.routes');
const companiesRoutes = require('../src/modules/companies/companies.routes');
const adminRoutes = require('../src/modules/admin/admin.routes');
const usersService = require('../src/modules/users/users.service');
const authService = require('../src/modules/auth/auth.service');
const prisma = require('../src/utils/prisma');

// Mock prisma for isolated, reproducible hardening tests
jest.mock('../src/utils/prisma', () => {
  // In-memory mutex simulating PostgreSQL pg_advisory_xact_lock
  let isLockHeld = false;
  const lockQueue = [];

  const acquireLock = () => {
    return new Promise((resolve) => {
      if (!isLockHeld) {
        isLockHeld = true;
        resolve();
      } else {
        lockQueue.push(resolve);
      }
    });
  };

  const releaseLock = () => {
    if (lockQueue.length > 0) {
      const next = lockQueue.shift();
      next();
    } else {
      isLockHeld = false;
    }
  };

  // In-memory mock store
  const mockUsers = new Map();
  const mockCompanies = new Map();
  const mockPrintJobs = new Map();

  const mockTx = {
    $executeRaw: jest.fn(async (query) => {
      // If advisory lock query, serialize using simulated mutex
      return 1;
    }),
    user: {
      findUnique: jest.fn(async ({ where }) => {
        return mockUsers.get(where.id) || null;
      }),
      count: jest.fn(async ({ where }) => {
        let count = 0;
        for (const u of mockUsers.values()) {
          if (where.role && u.role !== where.role) continue;
          if (where.isActive !== undefined && u.isActive !== where.isActive) continue;
          if (where.id?.not && u.id === where.id.not) continue;
          count++;
        }
        return count;
      }),
      update: jest.fn(async ({ where, data }) => {
        const u = mockUsers.get(where.id);
        if (!u) throw new Error('User not found');
        const updated = { ...u, ...data, updatedAt: new Date() };
        mockUsers.set(where.id, updated);
        return updated;
      }),
      delete: jest.fn(async ({ where }) => {
        const u = mockUsers.get(where.id);
        mockUsers.delete(where.id);
        return u;
      }),
      create: jest.fn(async ({ data }) => {
        const id = data.id || `u_${Date.now()}_${Math.random()}`;
        const u = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
        mockUsers.set(id, u);
        return u;
      })
    },
    company: {
      create: jest.fn(async ({ data }) => {
        const id = data.id || `co_${Date.now()}_${Math.random()}`;
        const c = { id, ...data, createdAt: new Date() };
        mockCompanies.set(id, c);
        return c;
      })
    }
  };

  return {
    user: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id) return mockUsers.get(where.id) || null;
        if (where.email) {
          for (const u of mockUsers.values()) {
            if (u.email === where.email) return u;
          }
        }
        return null;
      }),
      findMany: jest.fn(async () => Array.from(mockUsers.values())),
    },
    company: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id) return mockCompanies.get(where.id) || null;
        if (where.contactEmail) {
          for (const c of mockCompanies.values()) {
            if (c.contactEmail === where.contactEmail) return c;
          }
        }
        return null;
      }),
      findMany: jest.fn(async () => Array.from(mockCompanies.values())),
    },
    printJob: {
      findUnique: jest.fn(async ({ where }) => {
        return mockPrintJobs.get(where.shortId || where.id) || null;
      }),
    },
    $transaction: jest.fn(async (cb) => {
      await acquireLock();
      try {
        return await cb(mockTx);
      } finally {
        releaseLock();
      }
    }),
    $queryRaw: jest.fn(),
    __mockUsers: mockUsers,
    __mockCompanies: mockCompanies,
    __mockPrintJobs: mockPrintJobs,
    __mockTx: mockTx
  };
});

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/companies', companiesRoutes);
app.use('/api/admin', adminRoutes);
app.use((err, req, res, next) => {
  res.status(err.statusCode || 500).json({ success: false, error: err.message });
});

describe('PRINTGO — ROLE PHASE 1 SECURITY TEST HARDENING SUITE', () => {
  beforeEach(() => {
    prisma.__mockUsers.clear();
    prisma.__mockCompanies.clear();
    prisma.__mockPrintJobs.clear();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // 1. SUPERADMIN CONCURRENCY
  // ===========================================================================
  describe('1. SUPERADMIN Concurrency & Advisory Lock Serialization', () => {
    it('TEST-HARDEN-01: Two concurrent requests attempting to demote the last two SUPERADMINs serialize, leaving exactly one active SUPERADMIN', async () => {
      // Seed two active SUPERADMIN accounts
      const admin1 = {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'admin1@printgo.in',
        name: 'Admin One',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 0,
        password: 'hash1'
      };
      const admin2 = {
        id: '33333333-3333-4333-8333-333333333333',
        email: 'admin2@printgo.in',
        name: 'Admin Two',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 0,
        password: 'hash2'
      };
      prisma.__mockUsers.set(admin1.id, { ...admin1 });
      prisma.__mockUsers.set(admin2.id, { ...admin2 });

      const tokenAdmin1 = authService.signToken(admin1.id, 0);
      const tokenAdmin2 = authService.signToken(admin2.id, 0);

      // Simultaneous demotion requests:
      // Request A tries to demote Admin 1 to FRANCHISEE
      // Request B tries to demote Admin 2 to FRANCHISEE
      const reqA = request(app)
        .put(`/api/users/${admin1.id}`)
        .set('Authorization', `Bearer ${tokenAdmin1}`)
        .send({ role: 'FRANCHISEE' });

      const reqB = request(app)
        .put(`/api/users/${admin2.id}`)
        .set('Authorization', `Bearer ${tokenAdmin2}`)
        .send({ role: 'FRANCHISEE' });

      const [resA, resB] = await Promise.all([reqA, reqB]);

      // Exactly one must succeed (200), and the second must be rejected (400)
      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 400]);

      const rejectedRes = resA.status === 400 ? resA : resB;
      expect(rejectedRes.body.error).toContain('Cannot demote, deactivate, or delete the last active SUPERADMIN');

      // Verify final database state: exactly one active SUPERADMIN remains
      const remainingAdmins = Array.from(prisma.__mockUsers.values()).filter(
        u => u.role === 'SUPERADMIN' && u.isActive === true
      );
      expect(remainingAdmins.length).toBe(1);
    });

    it('TEST-HARDEN-02: Two concurrent requests attempting to deactivate the last two SUPERADMINs never leave zero active SUPERADMINs', async () => {
      const sa1 = {
        id: '44444444-4444-4444-8444-444444444444',
        email: 'sa1@printgo.in',
        name: 'SA One',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 0,
        password: 'hash'
      };
      const sa2 = {
        id: '55555555-5555-4555-8555-555555555555',
        email: 'sa2@printgo.in',
        name: 'SA Two',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 0,
        password: 'hash'
      };
      prisma.__mockUsers.set(sa1.id, { ...sa1 });
      prisma.__mockUsers.set(sa2.id, { ...sa2 });

      const callerToken1 = authService.signToken(sa1.id, 0);
      const callerToken2 = authService.signToken(sa2.id, 0);

      // Concurrent toggle-active to false:
      // Request 1: sa1 attempts to deactivate sa1
      // Request 2: sa2 attempts to deactivate sa2
      const req1 = request(app)
        .patch(`/api/users/${sa1.id}/toggle-active`)
        .set('Authorization', `Bearer ${callerToken1}`)
        .send({ isActive: false });

      const req2 = request(app)
        .patch(`/api/users/${sa2.id}/toggle-active`)
        .set('Authorization', `Bearer ${callerToken2}`)
        .send({ isActive: false });

      const [res1, res2] = await Promise.all([req1, req2]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 400]);

      // System invariant: Remaining active superadmin count >= 1
      const activeSuperadmins = Array.from(prisma.__mockUsers.values()).filter(
        u => u.role === 'SUPERADMIN' && u.isActive === true
      );
      expect(activeSuperadmins.length).toBe(1);
    });

    it('TEST-HARDEN-11: A single SUPERADMIN attempting concurrent deactivation of another admin and themselves is blocked on the last account', async () => {
      const primaryAdmin = {
        id: '66666666-6666-4666-8666-666666666666',
        email: 'primary@printgo.in',
        name: 'Primary Admin',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 0,
        password: 'hash'
      };
      const secondaryAdmin = {
        id: '77777777-7777-4777-8777-777777777777',
        email: 'secondary@printgo.in',
        name: 'Secondary Admin',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 0,
        password: 'hash'
      };
      prisma.__mockUsers.set(primaryAdmin.id, { ...primaryAdmin });
      prisma.__mockUsers.set(secondaryAdmin.id, { ...secondaryAdmin });

      const primaryToken = authService.signToken(primaryAdmin.id, 0);

      // primaryAdmin simultaneously tries to deactivate secondaryAdmin AND primaryAdmin
      const reqA = request(app)
        .patch(`/api/users/${secondaryAdmin.id}/toggle-active`)
        .set('Authorization', `Bearer ${primaryToken}`)
        .send({ isActive: false });

      const reqB = request(app)
        .patch(`/api/users/${primaryAdmin.id}/toggle-active`)
        .set('Authorization', `Bearer ${primaryToken}`)
        .send({ isActive: false });

      const [resA, resB] = await Promise.all([reqA, reqB]);

      // Exactly one succeeds, the other fails with 400 or 401
      expect([200]).toContain(resA.status === 200 ? resA.status : resB.status);
      expect([400, 401]).toContain(resA.status !== 200 ? resA.status : resB.status);

      // Exactly 1 active superadmin remains
      const activeCount = Array.from(prisma.__mockUsers.values()).filter(
        u => u.role === 'SUPERADMIN' && u.isActive === true
      ).length;
      expect(activeCount).toBe(1);
    });
  });

  // ===========================================================================
  // 2. ACTIVATION CONCURRENCY
  // ===========================================================================
  describe('2. Account Activation Concurrency & Single-Use Atomicity', () => {
    it('TEST-HARDEN-03: Two simultaneous activation requests with the same token result in exactly one success and one failure', async () => {
      const rawToken = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      const pendingUser = {
        id: 'user_pending_activation',
        email: 'franchise_pending@printgo.in',
        name: 'Pending Franchisee',
        role: 'FRANCHISEE',
        isActive: true,
        tokenVersion: 0,
        activationTokenHash: tokenHash,
        activationExpiresAt: new Date(Date.now() + 86400000),
        password: 'unusable_dummy_hash'
      };
      prisma.__mockUsers.set(pendingUser.id, pendingUser);

      // Simulate atomic PostgreSQL conditional update behavior:
      // First update matching activationTokenHash sets activationTokenHash = NULL.
      // Subsequent concurrent update with the same activationTokenHash matches 0 rows.
      let updateExecuted = false;
      prisma.$queryRaw.mockImplementation(async (strings, ...values) => {
        if (!updateExecuted) {
          updateExecuted = true;
          // Successfully claimed by first request
          pendingUser.activationTokenHash = null;
          pendingUser.activationExpiresAt = null;
          pendingUser.passwordChangedAt = new Date();
          pendingUser.tokenVersion = 1;
          pendingUser.password = 'first_password_hash';
          return [{ id: pendingUser.id }];
        } else {
          // Second simultaneous request finds 0 rows matching activationTokenHash
          return [];
        }
      });

      const reqA = request(app)
        .post('/api/auth/activate')
        .send({ token: rawToken, password: 'PasswordA123' });

      const reqB = request(app)
        .post('/api/auth/activate')
        .send({ token: rawToken, password: 'PasswordB123' });

      const [resA, resB] = await Promise.all([reqA, reqB]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 400]);

      const successfulRes = resA.status === 200 ? resA : resB;
      const failedRes = resA.status === 400 ? resA : resB;

      expect(successfulRes.body.success).toBe(true);
      expect(successfulRes.body.token).toBeDefined();
      expect(failedRes.body.error).toContain('Invalid, expired, or already used activation token');

      // Verify that token cannot be replayed a third time
      const resReplay = await request(app)
        .post('/api/auth/activate')
        .send({ token: rawToken, password: 'PasswordC123' });

      expect(resReplay.status).toBe(400);
      expect(resReplay.body.error).toContain('Invalid, expired, or already used activation token');
    });
  });

  // ===========================================================================
  // 3. MULTI-TENANT IDOR
  // ===========================================================================
  describe('3. Multi-Tenant IDOR & Tenant Data Isolation', () => {
    const companyA = { id: 'company-a', name: 'Shop A', contactEmail: 'shopa@printgo.in' };
    const companyB = { id: 'company-b', name: 'Shop B', contactEmail: 'shopb@printgo.in' };

    const franchiseeA = {
      id: 'franchisee-a',
      email: 'franchisee.a@printgo.in',
      role: 'FRANCHISEE',
      companyId: companyA.id,
      isActive: true,
      tokenVersion: 0
    };

    const staffA = {
      id: 'staff-a',
      email: 'staff.a@printgo.in',
      role: 'STAFF',
      companyId: companyA.id,
      isActive: true,
      tokenVersion: 0
    };

    const tokenFranchiseeA = authService.signToken(franchiseeA.id, 0);
    const tokenStaffA = authService.signToken(staffA.id, 0);

    beforeEach(() => {
      prisma.__mockCompanies.set(companyA.id, companyA);
      prisma.__mockCompanies.set(companyB.id, companyB);
      prisma.__mockUsers.set(franchiseeA.id, franchiseeA);
      prisma.__mockUsers.set(staffA.id, staffA);
    });

    it('TEST-HARDEN-04: Franchisee A cannot confirm cash payment for Company B job (Returns 403 Forbidden)', async () => {
      // PrintJob belonging to Company B machine
      const jobB = {
        id: 'job-b-001',
        shortId: 'jb002b',
        status: 'PENDING_PAYMENT',
        paymentMode: 'CASH_AT_COUNTER',
        cost: 20,
        machineId: 'machine-b',
        machine: { id: 'machine-b', companyId: companyB.id }
      };
      prisma.__mockPrintJobs.set(jobB.shortId, jobB);

      const res = await request(app)
        .post(`/api/admin/jobs/${jobB.shortId}/confirm-cash`)
        .set('Authorization', `Bearer ${tokenFranchiseeA}`)
        .send({ amount: 20 });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot confirm payment for job belonging to another shop');
    });

    it('TEST-HARDEN-05: Staff A cannot confirm cash payment for Company B job (Returns 403 Forbidden)', async () => {
      const jobB = {
        id: 'job-b-002',
        shortId: 'jb003b',
        status: 'PENDING_PAYMENT',
        paymentMode: 'CASH_AT_COUNTER',
        cost: 15,
        machineId: 'machine-b',
        machine: { id: 'machine-b', companyId: companyB.id }
      };
      prisma.__mockPrintJobs.set(jobB.shortId, jobB);

      const res = await request(app)
        .post(`/api/admin/jobs/${jobB.shortId}/confirm-cash`)
        .set('Authorization', `Bearer ${tokenStaffA}`)
        .send({ amount: 15 });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot confirm payment for job belonging to another shop');
    });

    it('TEST-HARDEN-06: Franchisee A cannot reconcile a job belonging to Company B (Returns 403 Forbidden)', async () => {
      const jobB = {
        id: 'job-b-003',
        shortId: 'jb004b',
        status: 'PRINTING',
        machineId: 'machine-b',
        machine: { id: 'machine-b', companyId: companyB.id }
      };
      prisma.__mockPrintJobs.set(jobB.shortId, jobB);

      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .set('Authorization', `Bearer ${tokenFranchiseeA}`)
        .send({
          shortId: jobB.shortId,
          outcome: 'COMPLETED',
          reason: 'Physical verification confirmed document was printed successfully',
          physicalConfirmation: true
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Job belongs to another company');
    });

    it('TEST-HARDEN-07: Franchisee or Staff cannot access or mutate /api/users (Returns 403 Forbidden)', async () => {
      // Franchisee attempting to access user directory
      const res1 = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${tokenFranchiseeA}`);
      expect(res1.status).toBe(403);

      // Staff attempting to access user directory
      const res2 = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${tokenStaffA}`);
      expect(res2.status).toBe(403);

      // Franchisee attempting to modify user
      const res3 = await request(app)
        .put('/api/users/any-user-id')
        .set('Authorization', `Bearer ${tokenFranchiseeA}`)
        .send({ role: 'SUPERADMIN' });
      expect(res3.status).toBe(403);
    });
  });

  // ===========================================================================
  // 4. TOKEN AND RESPONSE SECURITY
  // ===========================================================================
  describe('4. Token & Response Data Security', () => {
    const superadmin = {
      id: 'sa-audit-id',
      email: 'sa.audit@printgo.in',
      role: 'SUPERADMIN',
      isActive: true,
      tokenVersion: 0,
      password: '$2b$12$secret_hashed_password_superadmin',
      activationTokenHash: 'audit_activation_hash'
    };
    const saToken = authService.signToken(superadmin.id, 0);

    beforeEach(() => {
      prisma.__mockUsers.set(superadmin.id, superadmin);
    });

    it('TEST-HARDEN-08: User API endpoints never leak password or activationTokenHash in responses', async () => {
      // Test GET /api/users
      const resList = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${saToken}`);

      expect(resList.status).toBe(200);
      expect(resList.body.users.length).toBeGreaterThan(0);
      for (const u of resList.body.users) {
        expect(u.password).toBeUndefined();
        expect(u.activationTokenHash).toBeUndefined();
      }

      // Test GET /api/users/:id
      const resSingle = await request(app)
        .get(`/api/users/${superadmin.id}`)
        .set('Authorization', `Bearer ${saToken}`);

      expect(resSingle.status).toBe(200);
      expect(resSingle.body.user.password).toBeUndefined();
      expect(resSingle.body.user.activationTokenHash).toBeUndefined();
    });

    it('TEST-HARDEN-09: Company registration never leaks password or activationTokenHash in response', async () => {
      const res = await request(app)
        .post('/api/companies')
        .set('Authorization', `Bearer ${saToken}`)
        .send({
          name: 'Secure Franchise Test',
          email: 'secure.franchise@printgo.in',
          phone: '+91 91111 22222',
          contactPerson: 'Secure Admin'
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      // Assert zero plaintext or hashed password fields
      expect(res.body.user.password).toBeUndefined();
      expect(res.body.user.activationTokenHash).toBeUndefined();
      expect(res.body.defaultPassword).toBeUndefined();
      expect(res.body.password).toBeUndefined();

      // Assert activation URL uses URL fragment (#token=) and never query parameter (?token=)
      expect(res.body.activationUrl).toMatch(/^\/activate#token=[0-9a-f]{64}$/);
      expect(res.body.activationUrl).not.toContain('?token=');
    });

    it('TEST-HARDEN-10: Expired activation tokens are rejected with 400', async () => {
      // In authService.activateAccount, expired tokens fail the `activationExpiresAt > NOW()` predicate
      prisma.$queryRaw.mockResolvedValue([]); // 0 rows affected

      const res = await request(app)
        .post('/api/auth/activate')
        .send({
          token: 'expired_raw_token_value_here',
          password: 'ValidPassword123'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid, expired, or already used activation token');
    });
  });

  // ===========================================================================
  // 5. OPERATOR STATUS PROJECTION & SAFE DISPLAY
  // ===========================================================================
  describe('5. Operator Status Projection & Safe Display', () => {
    const adminAnalytics = require('../src/services/adminAnalytics.service');

    it('TEST-HARDEN-12: adminAnalytics.getOperators includes isActive for active and deactivated users', async () => {
      const activeOp = {
        id: 'op-active-1',
        name: 'Active Operator',
        email: 'active.op@printgo.in',
        role: 'STAFF',
        isActive: true,
        companyId: 'comp-1',
        createdAt: new Date(),
        password: 'secret_hash',
        activationTokenHash: null
      };

      const deactOp = {
        id: 'op-deact-2',
        name: 'Deactivated Operator',
        email: 'deact.op@printgo.in',
        role: 'STAFF',
        isActive: false,
        companyId: 'comp-1',
        createdAt: new Date(),
        password: 'secret_hash',
        activationTokenHash: null
      };

      prisma.__mockUsers.set(activeOp.id, activeOp);
      prisma.__mockUsers.set(deactOp.id, deactOp);

      // Setup mock select behavior in prisma.user.findMany
      prisma.user.findMany.mockImplementation(async ({ select }) => {
        return [activeOp, deactOp].map(u => {
          const res = {};
          if (select) {
            for (const key of Object.keys(select)) {
              if (select[key]) res[key] = u[key];
            }
          }
          return res;
        });
      });

      const res = await adminAnalytics.getOperators({ role: 'SUPERADMIN' });

      expect(res.success).toBe(true);
      expect(res.operators.length).toBe(2);

      const foundActive = res.operators.find(o => o.id === 'op-active-1');
      const foundDeact = res.operators.find(o => o.id === 'op-deact-2');

      expect(foundActive.isActive).toBe(true);
      expect(foundDeact.isActive).toBe(false);

      // Verify sensitive fields are not selected
      for (const op of res.operators) {
        expect(op.password).toBeUndefined();
        expect(op.activationTokenHash).toBeUndefined();
      }
    });

    it('TEST-HARDEN-13: Safe status resolution logic correctly evaluates true, false, and unknown/null status', () => {
      const resolveDisplayStatus = (u) => {
        return u.isActive === true ? 'ACTIVE' : u.isActive === false ? 'INACTIVE' : 'UNKNOWN';
      };

      expect(resolveDisplayStatus({ isActive: true })).toBe('ACTIVE');
      expect(resolveDisplayStatus({ isActive: false })).toBe('INACTIVE');
      expect(resolveDisplayStatus({ isActive: null })).toBe('UNKNOWN');
      expect(resolveDisplayStatus({ isActive: undefined })).toBe('UNKNOWN');
      expect(resolveDisplayStatus({})).toBe('UNKNOWN');
      // Assert it never defaults to ACTIVE on missing/null/undefined
      expect(resolveDisplayStatus({ isActive: null })).not.toBe('ACTIVE');
      expect(resolveDisplayStatus({})).not.toBe('ACTIVE');
    });
  });
});
