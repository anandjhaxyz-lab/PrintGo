const request = require('supertest');
const express = require('express');

let mockCurrentUser = null;

jest.mock('../src/middlewares/auth', () => ({
  protect: (req, res, next) => {
    req.user = mockCurrentUser;
    next();
  },
  restrictTo: (...roles) => (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  }
}));

jest.mock('../src/middlewares/readOnlyGuard', () => ({
  readOnlyGuard: (req, res, next) => next()
}));

const mockPrisma = {
  printJob: {
    findUnique: jest.fn()
  }
};
jest.mock('../src/utils/prisma', () => mockPrisma);

const mockJobsService = {
  resolveAmbiguousJob: jest.fn()
};
jest.mock('../src/modules/jobs/jobs.service', () => mockJobsService);

const adminRoutes = require('../src/modules/admin/admin.routes');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

describe('Admin Reconcile Job Security, Validation & Multi-Tenancy (Findings 2 & 3)', () => {
  const superadmin = {
    id: 'super-01',
    role: 'SUPERADMIN',
    email: 'super@printgo.test'
  };

  const franchiseeCompanyA = {
    id: 'fran-01',
    role: 'FRANCHISEE',
    companyId: 'company-A',
    email: 'franA@printgo.test'
  };

  const franchiseeCompanyB = {
    id: 'fran-02',
    role: 'FRANCHISEE',
    companyId: 'company-B',
    email: 'franB@printgo.test'
  };

  const sensitiveJobCompanyB = {
    id: 'job-uuid-200',
    shortId: 'PJ-200',
    status: 'PRINTING',
    machineId: 'm-200',
    cost: 50,
    pagesToPrint: 5,
    copies: 1,
    color: false,
    duplex: false,
    paperSize: 'A4',
    paymentMode: 'CASH',
    encryptedKey: 'CRITICAL_SECRET_ENCRYPTION_KEY',
    iv: 'CRITICAL_SECRET_IV',
    machine: {
      id: 'm-200',
      companyId: 'company-B',
      name: 'Kiosk B'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const sensitiveJobCompanyA = {
    id: 'job-uuid-100',
    shortId: 'PJ-100',
    status: 'PRINTING',
    machineId: 'm-100',
    cost: 20,
    pagesToPrint: 2,
    copies: 1,
    color: false,
    duplex: false,
    paperSize: 'A4',
    paymentMode: 'ONLINE',
    encryptedKey: 'CRITICAL_SECRET_ENCRYPTION_KEY_A',
    iv: 'CRITICAL_SECRET_IV_A',
    machine: {
      id: 'm-100',
      companyId: 'company-A',
      name: 'Kiosk A'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentUser = superadmin;
  });

  // =========================================================================
  // Finding 2: Input Validation, Explicit Outcomes & Physical Confirmation
  // =========================================================================
  describe('Finding 2 — Input Validation and Physical Confirmation Enforcement', () => {
    test('1. Rejects request containing only { shortId } with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({ shortId: 'PJ-xyz' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/explicit outcome of COMPLETED or FAILED is required/i);
    });

    test('2. Rejects request with missing or empty shortId with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({ outcome: 'COMPLETED', reason: 'Customer physical confirmation verified' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/shortId is required/i);
    });

    test('3. Rejects historical baseline job ab36197e with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'ab36197e',
          outcome: 'COMPLETED',
          physicalConfirmation: true,
          reason: 'Attempting to resolve baseline job'
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/ab36197e is protected and cannot be altered/i);
    });

    test('4. Rejects invalid outcome values with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-100',
          outcome: 'CANCELLED',
          reason: 'Cancelled by customer'
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/explicit outcome of COMPLETED or FAILED is required/i);
    });

    test('5. Rejects missing reason with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-100',
          outcome: 'COMPLETED',
          physicalConfirmation: true
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/operator reason of at least 10 non-whitespace characters is required/i);
    });

    test('6. Rejects whitespace-only or <10 character reason with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-100',
          outcome: 'FAILED',
          reason: '   done   '
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/operator reason of at least 10 non-whitespace characters is required/i);
    });

    test('7. Rejects reason exceeding 500 characters with 400 Bad Request', async () => {
      const longReason = 'a'.repeat(501);
      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-100',
          outcome: 'FAILED',
          reason: longReason
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/cannot exceed 500 characters/i);
    });

    test('8. Rejects outcome COMPLETED without physicalConfirmation with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-100',
          outcome: 'COMPLETED',
          reason: 'Paper came out cleanly from tray'
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/explicit physical confirmation .* is required/i);
    });

    test('9. Rejects outcome COMPLETED when spoolerEmptyOnly is true with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-100',
          outcome: 'COMPLETED',
          physicalConfirmation: true,
          spoolerEmptyOnly: true,
          reason: 'Windows queue shows 0 jobs in spooler'
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/spooler-empty status alone is insufficient evidence/i);
    });
  });

  // =========================================================================
  // Finding 3: Multi-Tenancy Authorization & Secret Stripping
  // =========================================================================
  describe('Finding 3 — Multi-Tenancy Enforcement and Secret Sanitization', () => {
    test('1. Franchisee cannot reconcile a job owned by another company when status is PRINTING (403 Forbidden)', async () => {
      mockCurrentUser = franchiseeCompanyA;
      mockPrisma.printJob.findUnique.mockResolvedValueOnce(sensitiveJobCompanyB);

      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-200',
          outcome: 'COMPLETED',
          physicalConfirmation: true,
          reason: 'Operator physically verified print'
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/access denied: job belongs to another company/i);
      expect(mockJobsService.resolveAmbiguousJob).not.toHaveBeenCalled();
    });

    test('2. Franchisee cannot reconcile a job owned by another company even if job.status === outcome (403 Forbidden)', async () => {
      mockCurrentUser = franchiseeCompanyA;
      mockPrisma.printJob.findUnique.mockResolvedValueOnce({
        ...sensitiveJobCompanyB,
        status: 'COMPLETED'
      });

      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-200',
          outcome: 'COMPLETED',
          physicalConfirmation: true,
          reason: 'Operator physically verified print'
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/access denied: job belongs to another company/i);
      // Zero data leakage: body must not contain job object or secrets
      expect(res.body.job).toBeUndefined();
    });

    test('3. Franchisee CAN reconcile a job owned by their own company', async () => {
      mockCurrentUser = franchiseeCompanyA;
      mockPrisma.printJob.findUnique.mockResolvedValueOnce(sensitiveJobCompanyA);
      mockJobsService.resolveAmbiguousJob.mockResolvedValueOnce({
        ...sensitiveJobCompanyA,
        status: 'COMPLETED'
      });

      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-100',
          outcome: 'COMPLETED',
          physicalConfirmation: true,
          reason: 'Franchisee verified customer received printed document'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.reconciled).toBe(true);
      expect(mockJobsService.resolveAmbiguousJob).toHaveBeenCalledWith(
        'PJ-100',
        expect.objectContaining({
          outcome: 'COMPLETED',
          reason: 'Franchisee verified customer received printed document',
          physicalConfirmation: true,
          spoolerEmptyOnly: false
        }),
        expect.objectContaining({ id: franchiseeCompanyA.id, companyId: 'company-A' })
      );
    });

    test('4. Superadmin can reconcile jobs across any company', async () => {
      mockCurrentUser = superadmin;
      mockPrisma.printJob.findUnique.mockResolvedValueOnce(sensitiveJobCompanyB);
      mockJobsService.resolveAmbiguousJob.mockResolvedValueOnce({
        ...sensitiveJobCompanyB,
        status: 'FAILED'
      });

      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-200',
          outcome: 'FAILED',
          reason: 'Superadmin inspected mechanical tray jam'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.reconciled).toBe(true);
      expect(mockJobsService.resolveAmbiguousJob).toHaveBeenCalledWith(
        'PJ-200',
        expect.objectContaining({
          outcome: 'FAILED',
          reason: 'Superadmin inspected mechanical tray jam'
        }),
        expect.objectContaining({ id: superadmin.id, role: 'SUPERADMIN' })
      );
    });

    test('5. Sanitizes response payload: encryptedKey and iv are NEVER exposed on transition', async () => {
      mockCurrentUser = superadmin;
      mockPrisma.printJob.findUnique.mockResolvedValueOnce(sensitiveJobCompanyB);
      mockJobsService.resolveAmbiguousJob.mockResolvedValueOnce({
        ...sensitiveJobCompanyB,
        status: 'COMPLETED'
      });

      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-200',
          outcome: 'COMPLETED',
          physicalConfirmation: true,
          reason: 'Verified document physical output'
        });

      expect(res.status).toBe(200);
      expect(res.body.job).toBeDefined();
      expect(res.body.job.id).toBe(sensitiveJobCompanyB.id);
      expect(res.body.job.shortId).toBe(sensitiveJobCompanyB.shortId);
      expect(res.body.job.encryptedKey).toBeUndefined();
      expect(res.body.job.iv).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('CRITICAL_SECRET_ENCRYPTION_KEY');
      expect(JSON.stringify(res.body)).not.toContain('CRITICAL_SECRET_IV');
    });

    test('6. Sanitizes response payload: encryptedKey and iv are NEVER exposed on idempotent return', async () => {
      mockCurrentUser = superadmin;
      mockPrisma.printJob.findUnique.mockResolvedValueOnce({
        ...sensitiveJobCompanyB,
        status: 'COMPLETED'
      });

      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-200',
          outcome: 'COMPLETED',
          physicalConfirmation: true,
          reason: 'Verified document physical output'
        });

      expect(res.status).toBe(200);
      expect(res.body.reconciled).toBe(false);
      expect(res.body.job).toBeDefined();
      expect(res.body.job.encryptedKey).toBeUndefined();
      expect(res.body.job.iv).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('CRITICAL_SECRET_ENCRYPTION_KEY');
      expect(JSON.stringify(res.body)).not.toContain('CRITICAL_SECRET_IV');
    });

    test('7. Returns 404 if job shortId does not exist', async () => {
      mockCurrentUser = superadmin;
      mockPrisma.printJob.findUnique.mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/admin/reconcile-job')
        .send({
          shortId: 'PJ-nonexistent',
          outcome: 'FAILED',
          reason: 'Valid operator reason here'
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/job not found/i);
    });
  });
});
