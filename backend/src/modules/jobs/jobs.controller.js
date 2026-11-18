const jobsService = require('./jobs.service');

const getAllJobs = async (req, res, next) => {
  try {
    const result = await jobsService.getAllJobs(req.user, req.query);
    const jobs = Array.isArray(result) ? result : result.jobs;
    res.json({
      success: true,
      jobs,
      pagination: result.pagination
    });
  } catch (error) {
    next(error);
  }
};

const getJob = async (req, res, next) => {
  try {
    const { id } = req.params;
    const job = await jobsService.getJobByShortId(id, req.user);
    
    // STRICT IDOR & SESSION PROTECTION:
    if (req.session) {
      // 1. Session to Machine Check
      if (req.session.machineId) {
        if (job.machineId !== req.session.machineId) {
          return res.status(403).json({ success: false, error: 'Access denied: Job belongs to a different machine' });
        }
      } else {
        if (job.machineId !== null) {
          return res.status(403).json({ success: false, error: 'Access denied: Cannot access machine-assigned jobs without a machine session' });
        }
      }

      // 2. Cross-Session Isolation Check
      let jobSessionId = null;
      if (job.pricingSnapshot) {
        try {
          const snap = JSON.parse(job.pricingSnapshot);
          jobSessionId = snap.sessionId;
        } catch (e) {}
      }
      if (jobSessionId && req.session.sessionId && jobSessionId !== req.session.sessionId) {
        return res.status(403).json({ success: false, error: 'Access denied: You can only view jobs created in your session' });
      }
    }
    
    res.json({ success: true, job });
  } catch (error) {
    next(error);
  }
};

const createJob = async (req, res, next) => {
  try {
    const jobData = { ...req.body };
    if (req.session) {
      if (!req.session.machineId) {
        const AppError = require('../../utils/AppError');
        return next(new AppError('Session is not bound to a valid printer', 400));
      }
      // Strictly bind machineId and session paymentMode from server-side session token — ignore any client parameter
      jobData.machineId = req.session.machineId;
      jobData.sessionId = req.session.sessionId;
      jobData.paymentMode = req.session.paymentMode;
    }
    const job = await jobsService.createJob(jobData);
    res.json({ success: true, job });
  } catch (error) {
    next(error);
  }
};

const updateJobStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const { id } = req.params;
    
    const job = await jobsService.updateJobStatus(id, status, req.user);
    req.app.get('io').emit('job_status_changed', job);
    res.json({ success: true, job });
  } catch (error) {
    next(error);
  }
};

const exportJobsCsv = async (req, res, next) => {
  try {
    const result = await jobsService.getAllJobs(req.user, { limit: 1000 });
    const jobs = Array.isArray(result) ? result : result.jobs;
    
    // Build CSV Header
    let csv = 'Job ID,Date,Status,Machine,Customer,Document,Pages,Color,Duplex,Cost (INR)\n';
    
    // Build CSV Rows
    jobs.forEach(job => {
      const date = new Date(job.createdAt).toISOString();
      const machineName = job.machine ? `"${job.machine.name}"` : 'Unassigned';
      const customerStr = job.customer ? `"${job.customer.phone || job.customer.email}"` : 'Walk-in';
      const docName = job.document ? `"${job.document.originalName}"` : 'Unknown';
      
      csv += `${job.shortId},${date},${job.status},${machineName},${customerStr},${docName},${job.pagesToPrint},${job.color},${job.duplex},${job.cost}\n`;
    });
    
    res.header('Content-Type', 'text/csv');
    res.attachment(`printgo_jobs_${new Date().toISOString().split('T')[0]}.csv`);
    return res.send(csv);
  } catch (error) {
    next(error);
  }
};

const { getInvoiceByShortId, generateInvoiceForJob, INVOICE_DIR } = require('../../services/invoice.service');
const path = require('path');
const fs = require('fs');
const logger = require('../../utils/logger');

// Security helper: Authorizes customer session or admin user access
const authorizeJobAccess = (job, req) => {
  if (!job) return false;

  // Authenticated Admin / Franchisee User
  if (req.user) {
    if (req.user.role === 'SUPERADMIN') return true;
    if (job.machine && job.machine.companyId === req.user.companyId) return true;
    return false;
  }

  // Customer Mobile / Kiosk Session
  if (req.session) {
    if (req.session.machineId) {
      if (job.machineId !== req.session.machineId) return false;
    } else if (job.machineId !== null) {
      return false;
    }

    let jobSessionId = null;
    if (job.pricingSnapshot) {
      try {
        const snap = typeof job.pricingSnapshot === 'string'
          ? JSON.parse(job.pricingSnapshot)
          : job.pricingSnapshot;
        jobSessionId = snap?.sessionId || null;
      } catch {}
    }
    if (jobSessionId && req.session.sessionId && jobSessionId !== req.session.sessionId) {
      return false;
    }

    return true;
  }

  return false;
};

const getInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;
    let job;
    try {
      job = await jobsService.getJobByShortId(id, req.user);
    } catch {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // SEC-02: Verify session ownership without exposing existence
    if (!authorizeJobAccess(job, req)) {
      logger.warn(`Security alert: Unauthorized invoice metadata access attempt: job ${id} from IP ${req.ip}`);
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const invoice = await getInvoiceByShortId(id);
    res.json({ success: true, invoice });
  } catch (error) {
    next(error);
  }
};

const downloadInvoicePdf = async (req, res, next) => {
  try {
    const { id } = req.params;
    let job;
    try {
      job = await jobsService.getJobByShortId(id, req.user);
    } catch {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // SEC-01: Verify session ownership without exposing existence
    if (!authorizeJobAccess(job, req)) {
      logger.warn(`Security alert: Unauthorized invoice PDF download attempt: job ${id} from IP ${req.ip}`);
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const invoice = await getInvoiceByShortId(id);

    // Anti-path-traversal protection
    const sanitizedNumber = invoice.invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, '');
    const pdfPath = path.resolve(INVOICE_DIR, `${sanitizedNumber}.pdf`);
    
    if (!pdfPath.startsWith(path.resolve(INVOICE_DIR))) {
      logger.warn(`Security alert: Path traversal rejected for invoice ${invoice.invoiceNumber}`);
      return res.status(400).json({ success: false, error: 'Invalid invoice path' });
    }

    if (!fs.existsSync(pdfPath)) {
      await generateInvoiceForJob(id);
    }

    res.download(pdfPath, `${sanitizedNumber}.pdf`);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getInvoice,
  downloadInvoicePdf,
  getAllJobs,
  getJob,
  createJob,
  updateJobStatus,
  exportJobsCsv
};
