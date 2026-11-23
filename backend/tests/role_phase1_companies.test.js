process.env.JWT_SECRET = 'test_jwt_secret_role_phase1_comp';

const request = require('supertest');
const express = require('express');
const companiesRoutes = require('../src/modules/companies/companies.routes');
const { signToken } = require('../src/modules/auth/auth.service');
const prisma = require('../src/utils/prisma');

jest.mock('../src/utils/prisma', () => {
  const mockTx = {
    company: {
      create: jest.fn(),
    },
    user: {
      create: jest.fn(),
    }
  };

  return {
    company: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(async (cb) => {
      return await cb(mockTx);
    }),
    __mockTx: mockTx
  };
});

const app = express();
app.use(express.json());
app.use('/api/companies', companiesRoutes);
app.use((err, req, res, next) => {
  res.status(err.statusCode || 500).json({ success: false, error: err.message });
});

describe('Role Phase 1 - Company Onboarding & Franchisee Activation Link', () => {
  const superadminUser = {
    id: 'caller-sa-id',
    email: 'superadmin@printgo.in',
    role: 'SUPERADMIN',
    isActive: true,
    tokenVersion: 0
  };
  const franchiseeUser = {
    id: 'caller-fr-id',
    email: 'franchisee@printgo.in',
    role: 'FRANCHISEE',
    isActive: true,
    tokenVersion: 0
  };

  const superadminToken = signToken(superadminUser.id, 0);
  const franchiseeToken = signToken(franchiseeUser.id, 0);

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('TEST-COMP-01: atomically creates Company & Franchisee with activation token and fragment URL', async () => {
    prisma.user.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === superadminUser.id) return superadminUser;
      if (where.email === 'newshop@printgo.in') return null; // No duplicate user
      return null;
    });

    prisma.company.findUnique.mockResolvedValue(null); // No duplicate company

    const mockTx = prisma.__mockTx;
    mockTx.company.create.mockResolvedValue({
      id: 'comp-101',
      name: 'Alpha Copy & Print',
      contactEmail: 'newshop@printgo.in',
      contactPhone: '+91 99999 88888',
      createdAt: new Date(),
    });

    mockTx.user.create.mockResolvedValue({
      id: 'user-202',
      name: 'Alpha Admin',
      email: 'newshop@printgo.in',
      role: 'FRANCHISEE',
      companyId: 'comp-101',
      isActive: true,
      tokenVersion: 0,
      password: 'hashed_dummy_password',
      activationTokenHash: 'some_sha256_hash',
      activationExpiresAt: new Date(Date.now() + 86400000),
    });

    const res = await request(app)
      .post('/api/companies')
      .set('Authorization', `Bearer ${superadminToken}`)
      .send({
        name: 'Alpha Copy & Print',
        contactPerson: 'Alpha Admin',
        email: 'newshop@printgo.in',
        phone: '+91 99999 88888',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.company.id).toBe('comp-101');
    expect(res.body.user.id).toBe('user-202');
    expect(res.body.activationUrl).toMatch(/^\/activate#token=[a-f0-9]{64}$/);

    // TEST-COMP-02: Zero plaintext password returned
    expect(res.body.user.password).toBeUndefined();
    expect(res.body.defaultPassword).toBeUndefined();
    expect(res.body.password).toBeUndefined();
    expect(res.body.user.activationTokenHash).toBeUndefined();

    // TEST-COMP-05: Cache-Control and Referrer-Policy headers
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('TEST-COMP-03: rejects duplicate company email or user email', async () => {
    prisma.user.findUnique.mockResolvedValue(superadminUser);
    prisma.company.findUnique.mockResolvedValue({ id: 'existing-comp', contactEmail: 'dup@printgo.in' });

    const res = await request(app)
      .post('/api/companies')
      .set('Authorization', `Bearer ${superadminToken}`)
      .send({
        name: 'Duplicate Company',
        email: 'dup@printgo.in',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Company with this email already exists');
  });

  it('TEST-COMP-04: restricts company creation to SUPERADMIN only', async () => {
    prisma.user.findUnique.mockResolvedValue(franchiseeUser);

    const res = await request(app)
      .post('/api/companies')
      .set('Authorization', `Bearer ${franchiseeToken}`)
      .send({
        name: 'Forbidden Company',
        email: 'forbidden@printgo.in',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('You do not have permission to perform this action');
  });
});
