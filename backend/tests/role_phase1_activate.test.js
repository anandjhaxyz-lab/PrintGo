process.env.JWT_SECRET = 'test_jwt_secret_role_phase1_activate';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const authRoutes = require('../src/modules/auth/auth.routes');
const authService = require('../src/modules/auth/auth.service');
const prisma = require('../src/utils/prisma');

jest.mock('../src/utils/prisma', () => ({
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
  },
  $queryRaw: jest.fn(),
  machine: {
    findUnique: jest.fn()
  },
  session: {
    findUnique: jest.fn()
  }
}));

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use((err, req, res, next) => {
  res.status(err.statusCode || 500).json({ success: false, error: err.message });
});

describe('Role Phase 1 - Account Activation & Pending Guard', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Login Pending Activation Guard', () => {
    it('TEST-ACTIVATE-01: rejects login when account activation is pending', async () => {
      const plainPassword = 'DummyPassword123';
      const hashedPassword = await bcrypt.hash(plainPassword, 10);

      prisma.user.findUnique.mockResolvedValue({
        id: 'pending-user',
        email: 'pending@printgo.in',
        password: hashedPassword,
        role: 'FRANCHISEE',
        isActive: true,
        activationTokenHash: 'sha256_hash_here',
        activationExpiresAt: new Date(Date.now() + 86400000),
      });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'pending@printgo.in', password: plainPassword });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Account activation pending');
    });

    it('TEST-ACTIVATE-02: rejects login when account is deactivated', async () => {
      const plainPassword = 'DeactivatedPassword123';
      const hashedPassword = await bcrypt.hash(plainPassword, 10);

      prisma.user.findUnique.mockResolvedValue({
        id: 'deact-user',
        email: 'deact@printgo.in',
        password: hashedPassword,
        role: 'STAFF',
        isActive: false, // Deactivated
        activationTokenHash: null,
      });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'deact@printgo.in', password: plainPassword });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Your account has been deactivated');
    });
  });

  describe('Account Activation Endpoint', () => {
    it('TEST-ACTIVATE-03: activates account atomically with valid token and sets response security headers', async () => {
      const rawToken = '0123456789abcdef0123456789abcdef';
      const newPassword = 'BrandNewPassword123';

      // Atomic conditional query raw returns the updated user id
      prisma.$queryRaw.mockResolvedValue([{ id: 'activated-user-id' }]);
      prisma.user.findUnique.mockResolvedValue({
        id: 'activated-user-id',
        email: 'activated@printgo.in',
        role: 'FRANCHISEE',
        isActive: true,
        tokenVersion: 1,
        company: { id: 'comp-1', name: 'Test Shop' }
      });

      const res = await request(app)
        .post('/api/auth/activate')
        .send({ token: rawToken, password: newPassword });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.id).toBe('activated-user-id');
      expect(res.body.user.password).toBeUndefined();

      // Check Cache-Control and Referrer-Policy headers
      expect(res.headers['cache-control']).toContain('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('TEST-ACTIVATE-04: rejects already used or expired activation token (0 rows affected)', async () => {
      // When token is already used or expired, atomic update affects 0 rows
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await request(app)
        .post('/api/auth/activate')
        .send({ token: 'used-or-expired-token', password: 'ValidPassword123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid, expired, or already used activation token');
    });

    it('TEST-ACTIVATE-05: validates input schema rejecting empty token or short password', async () => {
      const res1 = await request(app)
        .post('/api/auth/activate')
        .send({ token: '', password: 'ValidPassword123' });

      expect(res1.status).toBe(400);

      const res2 = await request(app)
        .post('/api/auth/activate')
        .send({ token: 'valid-token', password: '123' }); // Under 6 characters

      expect(res2.status).toBe(400);
    });
  });
});
