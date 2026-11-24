process.env.JWT_SECRET = 'test_jwt_secret_role_phase1';

const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const { protect, resolveLegacySunsetCutoff, HARD_IMMUTABLE_SUNSET_MS } = require('../src/middlewares/auth');
const authService = require('../src/modules/auth/auth.service');
const prisma = require('../src/utils/prisma');

jest.mock('../src/utils/prisma', () => ({
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
  },
  $queryRaw: jest.fn(),
}));

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.get('/api/test-protected', protect, (req, res) => {
    res.json({ success: true, user: { id: req.user.id, role: req.user.role } });
  });
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  });
  return app;
};

describe('Role Phase 1 - Auth & Fail-Closed Token Sunset', () => {
  const originalEnv = process.env.LEGACY_JWT_SUNSET_UTC;

  afterEach(() => {
    process.env.LEGACY_JWT_SUNSET_UTC = originalEnv;
    jest.clearAllMocks();
  });

  describe('resolveLegacySunsetCutoff', () => {
    it('returns HARD_IMMUTABLE_SUNSET_MS when env var is unset or empty', () => {
      delete process.env.LEGACY_JWT_SUNSET_UTC;
      expect(resolveLegacySunsetCutoff()).toBe(HARD_IMMUTABLE_SUNSET_MS);

      process.env.LEGACY_JWT_SUNSET_UTC = '   ';
      expect(resolveLegacySunsetCutoff()).toBe(HARD_IMMUTABLE_SUNSET_MS);
    });

    it('fails closed (returns 0) for invalid non-numeric or negative values', () => {
      process.env.LEGACY_JWT_SUNSET_UTC = 'not_a_number';
      expect(resolveLegacySunsetCutoff()).toBe(0);

      process.env.LEGACY_JWT_SUNSET_UTC = '-500';
      expect(resolveLegacySunsetCutoff()).toBe(0);

      process.env.LEGACY_JWT_SUNSET_UTC = 'NaN';
      expect(resolveLegacySunsetCutoff()).toBe(0);
    });

    it('clamps values that exceed HARD_IMMUTABLE_SUNSET_MS to the hard ceiling', () => {
      process.env.LEGACY_JWT_SUNSET_UTC = '2500000000000';
      expect(resolveLegacySunsetCutoff()).toBe(HARD_IMMUTABLE_SUNSET_MS);
    });

    it('accepts valid earlier timestamps below the ceiling', () => {
      const validEarlier = 1750000000000;
      process.env.LEGACY_JWT_SUNSET_UTC = String(validEarlier);
      expect(resolveLegacySunsetCutoff()).toBe(validEarlier);
    });
  });

  describe('protect Middleware & Token Invalidation', () => {
    const app = createApp();

    it('TEST-AUTH-01: accepts legacy JWT without tokenVersion before cutoff if passwordChangedAt is null', async () => {
      // Legacy token signed without tokenVersion
      const legacyToken = jwt.sign({ id: 'user-123' }, process.env.JWT_SECRET);

      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'legacy@printgo.in',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 0,
        passwordChangedAt: null,
      });

      // Sunset in the future
      process.env.LEGACY_JWT_SUNSET_UTC = String(Date.now() + 100000);

      const res = await request(app)
        .get('/api/test-protected')
        .set('Authorization', `Bearer ${legacyToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.id).toBe('user-123');
    });

    it('TEST-AUTH-02: rejects legacy JWT if user passwordChangedAt is not null', async () => {
      const legacyToken = jwt.sign({ id: 'user-123' }, process.env.JWT_SECRET);

      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'legacy@printgo.in',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 1,
        passwordChangedAt: new Date(),
      });

      const res = await request(app)
        .get('/api/test-protected')
        .set('Authorization', `Bearer ${legacyToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('User recently changed password');
    });

    it('TEST-AUTH-03: rejects legacy JWT after fail-closed cutoff or with invalid env var', async () => {
      const legacyToken = jwt.sign({ id: 'user-123' }, process.env.JWT_SECRET);

      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'legacy@printgo.in',
        role: 'SUPERADMIN',
        isActive: true,
        tokenVersion: 0,
        passwordChangedAt: null,
      });

      // Force immediate sunset via invalid env
      process.env.LEGACY_JWT_SUNSET_UTC = 'invalid_env';

      const res = await request(app)
        .get('/api/test-protected')
        .set('Authorization', `Bearer ${legacyToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Legacy session has expired');
    });

    it('TEST-AUTH-04: accepts token matching current tokenVersion and rejects when tokenVersion increments', async () => {
      const validToken = authService.signToken('user-456', 2);

      // Decoded tokenVersion is 2, matches DB user tokenVersion 2
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-456',
        email: 'versioned@printgo.in',
        role: 'FRANCHISEE',
        isActive: true,
        tokenVersion: 2,
        passwordChangedAt: new Date(),
      });

      const res1 = await request(app)
        .get('/api/test-protected')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res1.status).toBe(200);
      expect(res1.body.user.id).toBe('user-456');

      // Now simulate tokenVersion increment on user deactivation or password change
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-456',
        email: 'versioned@printgo.in',
        role: 'FRANCHISEE',
        isActive: true,
        tokenVersion: 3, // Changed
        passwordChangedAt: new Date(),
      });

      const res2 = await request(app)
        .get('/api/test-protected')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res2.status).toBe(401);
      expect(res2.body.error).toContain('User recently changed password or session was invalidated');
    });

    it('TEST-AUTH-05: rejects deactivated user (isActive = false)', async () => {
      const token = authService.signToken('user-789', 0);

      prisma.user.findUnique.mockResolvedValue({
        id: 'user-789',
        email: 'deactivated@printgo.in',
        role: 'STAFF',
        isActive: false, // Deactivated
        tokenVersion: 0,
        passwordChangedAt: null,
      });

      const res = await request(app)
        .get('/api/test-protected')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Your account has been deactivated');
    });
  });
});
