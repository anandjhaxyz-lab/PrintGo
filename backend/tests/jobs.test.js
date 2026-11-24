const request = require('supertest');
const express = require('express');
const jobsRoutes = require('../src/modules/jobs/jobs.routes');
const jobsService = require('../src/modules/jobs/jobs.service');

jest.mock('../src/modules/jobs/jobs.service');
// Mock auth middlewares
jest.mock('../src/middlewares/auth', () => ({
  protect: (req, res, next) => {
    req.user = { id: '1', role: 'FRANCHISEE', companyId: 'comp-1' };
    next();
  },
  restrictTo: (...roles) => (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  }
}));
jest.mock('../src/middlewares/session', () => ({
  requireSessionOrUser: (req, res, next) => next()
}));

const app = express();
app.use(express.json());
app.use('/api/jobs', jobsRoutes);

app.use((err, req, res, next) => {
  res.status(err.statusCode || 500).json({ success: false, error: err.message });
});

describe('Jobs Endpoints', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/jobs', () => {
    it('should return jobs for the authenticated user', async () => {
      jobsService.getAllJobs.mockResolvedValue([
        { id: 'job-1', shortId: '1234abcd', status: 'COMPLETED' }
      ]);

      const res = await request(app).get('/api/jobs');

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.jobs.length).toBe(1);
      // Ensure the service was called with the user object and query params (for tenant isolation + pagination)
      expect(jobsService.getAllJobs).toHaveBeenCalledWith(
        expect.objectContaining({ id: '1', companyId: 'comp-1' }),
        expect.any(Object)
      );
    });
  });

  describe('POST /api/jobs', () => {
    it('should validate zod schema for create job', async () => {
      // Missing file and settings
      const res = await request(app).post('/api/jobs').send({});

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('PUT /api/jobs/:id/status', () => {
    it('should delegate to jobsService.updateJobStatus with options', async () => {
      jobsService.updateJobStatus.mockResolvedValue({ id: 'job-1', shortId: 'job123', status: 'WAITING' });

      const res = await request(app)
        .put('/api/jobs/job123/status')
        .send({ status: 'WAITING' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(jobsService.updateJobStatus).toHaveBeenCalledWith(
        'job123',
        'WAITING',
        expect.objectContaining({ id: '1', role: 'FRANCHISEE' }),
        expect.objectContaining({ reason: undefined })
      );
    });

    it('should reject invalid status with 400', async () => {
      const res = await request(app)
        .put('/api/jobs/job123/status')
        .send({ status: 'INVALID_STATUS' });

      expect(res.statusCode).toEqual(400);
    });
  });

  describe('POST /api/jobs/:id/resolve-ambiguity', () => {
    it('should delegate to jobsService.resolveAmbiguousJob', async () => {
      jobsService.resolveAmbiguousJob.mockResolvedValue({ id: 'job-1', shortId: 'job123', status: 'COMPLETED' });

      const res = await request(app)
        .post('/api/jobs/job123/resolve-ambiguity')
        .send({
          outcome: 'COMPLETED',
          physicalConfirmation: true,
          reason: 'Physical verification confirmed by operator'
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(jobsService.resolveAmbiguousJob).toHaveBeenCalledWith(
        'job123',
        expect.objectContaining({
          outcome: 'COMPLETED',
          physicalConfirmation: true,
          reason: 'Physical verification confirmed by operator'
        }),
        expect.objectContaining({ id: '1', role: 'FRANCHISEE' })
      );
    });
  });
});
