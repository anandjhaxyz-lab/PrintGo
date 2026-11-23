process.env.JWT_SECRET = 'test_jwt_secret_role_phase1_sa';

const request = require('supertest');
const express = require('express');
const usersRoutes = require('../src/modules/users/users.routes');
const { SUPERADMIN_MUTATION_LOCK_ID } = require('../src/modules/users/users.service');
const { signToken } = require('../src/modules/auth/auth.service');
const prisma = require('../src/utils/prisma');

jest.mock('../src/utils/prisma', () => {
  const mockTx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    user: {
      findUnique: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    }
  };

  return {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(async (cb) => {
      return await cb(mockTx);
    }),
    __mockTx: mockTx
  };
});

const app = express();
app.use(express.json());
app.use('/api/users', usersRoutes);
app.use((err, req, res, next) => {
  res.status(err.statusCode || 500).json({ success: false, error: err.message });
});

describe('Role Phase 1 - SUPERADMIN Mutation Service & Advisory Lock', () => {
  const superadminUser = {
    id: 'caller-sa-id',
    email: 'caller@printgo.in',
    role: 'SUPERADMIN',
    isActive: true,
    tokenVersion: 0
  };
  const callerToken = signToken(superadminUser.id, 0);

  beforeEach(() => {
    // protect middleware finds caller
    prisma.user.findUnique.mockResolvedValue(superadminUser);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Sole Active SUPERADMIN Protection', () => {
    it('TEST-SUPERADMIN-01: blocks deactivating the last active SUPERADMIN via toggle-active', async () => {
      const mockTx = prisma.__mockTx;
      mockTx.user.findUnique.mockResolvedValue({
        id: 'target-sa-id',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 0
      });
      // 0 remaining active superadmins
      mockTx.user.count.mockResolvedValue(0);

      const res = await request(app)
        .patch('/api/users/88888888-4444-4444-8888-888888888888/toggle-active')
        .set('Authorization', `Bearer ${callerToken}`)
        .send({ isActive: false });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot demote, deactivate, or delete the last active SUPERADMIN');
      expect(mockTx.$executeRaw).toHaveBeenCalled();
    });

    it('TEST-SUPERADMIN-02: blocks demoting the last active SUPERADMIN via PUT /api/users/:id', async () => {
      const mockTx = prisma.__mockTx;
      mockTx.user.findUnique.mockResolvedValue({
        id: 'target-sa-id',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 0
      });
      mockTx.user.count.mockResolvedValue(0);

      const res = await request(app)
        .put('/api/users/88888888-4444-4444-8888-888888888888')
        .set('Authorization', `Bearer ${callerToken}`)
        .send({ role: 'FRANCHISEE' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot demote, deactivate, or delete the last active SUPERADMIN');
    });

    it('TEST-SUPERADMIN-03: blocks deleting the last active SUPERADMIN via DELETE /api/users/:id', async () => {
      const mockTx = prisma.__mockTx;
      mockTx.user.findUnique.mockResolvedValue({
        id: 'target-sa-id',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 0
      });
      mockTx.user.count.mockResolvedValue(0);

      const res = await request(app)
        .delete('/api/users/88888888-4444-4444-8888-888888888888')
        .set('Authorization', `Bearer ${callerToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot demote, deactivate, or delete the last active SUPERADMIN');
    });

    it('TEST-SUPERADMIN-04: succeeds when another active SUPERADMIN exists (remainingActiveCount >= 1)', async () => {
      const mockTx = prisma.__mockTx;
      mockTx.user.findUnique.mockResolvedValue({
        id: 'target-sa-id',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 0
      });
      // 1 remaining active superadmin exists
      mockTx.user.count.mockResolvedValue(1);
      mockTx.user.update.mockResolvedValue({
        id: 'target-sa-id',
        role: 'FRANCHISEE',
        isActive: true,
        tokenVersion: 1,
        password: 'hash',
        activationTokenHash: null
      });

      const res = await request(app)
        .put('/api/users/88888888-4444-4444-8888-888888888888')
        .set('Authorization', `Bearer ${callerToken}`)
        .send({ role: 'FRANCHISEE' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.role).toBe('FRANCHISEE');
      expect(res.body.user.password).toBeUndefined();
    });

    it('TEST-SUPERADMIN-05: permits reactivating an inactive SUPERADMIN without last-admin check block', async () => {
      const mockTx = prisma.__mockTx;
      // Target is currently inactive
      mockTx.user.findUnique.mockResolvedValue({
        id: 'inactive-sa-id',
        role: 'SUPERADMIN',
        isActive: false,
        tokenVersion: 1
      });
      mockTx.user.update.mockResolvedValue({
        id: 'inactive-sa-id',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 2,
        password: 'hash'
      });

      const res = await request(app)
        .patch('/api/users/88888888-4444-4444-8888-888888888888/toggle-active')
        .set('Authorization', `Bearer ${callerToken}`)
        .send({ isActive: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.isActive).toBe(true);
      // count should NOT have been called because wasActiveSuperadmin was false
      expect(mockTx.user.count).not.toHaveBeenCalled();
    });
  });

  describe('Strict Boolean Validation', () => {
    it('TEST-SUPERADMIN-06: rejects string "false", "true", 0, 1, or null for isActive', async () => {
      const resStringFalse = await request(app)
        .patch('/api/users/88888888-4444-4444-8888-888888888888/toggle-active')
        .set('Authorization', `Bearer ${callerToken}`)
        .send({ isActive: "false" });
      expect(resStringFalse.status).toBe(400);

      const resStringTrue = await request(app)
        .patch('/api/users/88888888-4444-4444-8888-888888888888/toggle-active')
        .set('Authorization', `Bearer ${callerToken}`)
        .send({ isActive: "true" });
      expect(resStringTrue.status).toBe(400);

      const resNumberZero = await request(app)
        .patch('/api/users/88888888-4444-4444-8888-888888888888/toggle-active')
        .set('Authorization', `Bearer ${callerToken}`)
        .send({ isActive: 0 });
      expect(resNumberZero.status).toBe(400);

      const resNull = await request(app)
        .patch('/api/users/88888888-4444-4444-8888-888888888888/toggle-active')
        .set('Authorization', `Bearer ${callerToken}`)
        .send({ isActive: null });
      expect(resNull.status).toBe(400);
    });
  });
});
