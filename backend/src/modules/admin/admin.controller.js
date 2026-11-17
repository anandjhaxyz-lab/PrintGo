const prisma = require('../../utils/prisma');
const AppError = require('../../utils/AppError');
const { computePrinterAvailability } = require('../../services/printerAvailability.service');

// @desc    Get global stats
// @route   GET /api/admin/stats
// @access  Private (SUPERADMIN only)
exports.getStats = async (req, res, next) => {
  try {
    const totalCompanies = await prisma.company.count();
    const totalMachines = await prisma.machine.count();
    const totalUsers = await prisma.user.count();
    const totalJobs = await prisma.printJob.count();
    
    // Revenue stats
    const successfulPayments = await prisma.payment.aggregate({
      where: { status: 'SUCCESS' },
      _sum: { amount: true }
    });

    res.status(200).json({
      status: 'success',
      data: {
        totalCompanies,
        totalMachines,
        totalUsers,
        totalJobs,
        totalRevenue: successfulPayments._sum.amount || 0
      }
    });
  } catch (error) {
    next(new AppError('Failed to fetch stats', 500));
  }
};

// @desc    Get all companies
// @route   GET /api/admin/companies
// @access  Private (SUPERADMIN only)
exports.getAllCompanies = async (req, res, next) => {
  try {
    const companies = await prisma.company.findMany({
      include: {
        _count: {
          select: { machines: true, users: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.status(200).json({
      status: 'success',
      data: { companies }
    });
  } catch (error) {
    next(new AppError('Failed to fetch companies', 500));
  }
};

// @desc    Get all machines globally
// @route   GET /api/admin/machines
// @access  Private (SUPERADMIN only)
exports.getAllMachines = async (req, res, next) => {
  try {
    const machines = await prisma.machine.findMany({
      include: {
        company: {
          select: { name: true }
        },
        printerStatuses: {
          take: 1,
          orderBy: { timestamp: 'desc' }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const machinesWithAvailability = machines.map(m => {
      const latestStatus = m.printerStatuses?.[0] || null;
      const availability = computePrinterAvailability(m, latestStatus);
      return {
        ...m,
        isOnline: availability.isReady,
        agentOnline: availability.agentOnline,
        hardwareStatus: availability.status,
        statusMessage: availability.statusMessage,
      };
    });

    res.status(200).json({
      status: 'success',
      data: { machines: machinesWithAvailability }
    });
  } catch (error) {
    next(new AppError('Failed to fetch machines', 500));
  }
};

// ==============================================
// PRICING & BILLING MANAGEMENT
// ==============================================

exports.getPricingProfiles = async (req, res, next) => {
  try {
    const profiles = await prisma.printPricingProfile.findMany({
      include: { machine: { select: { id: true, name: true, location: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.status(200).json({ status: 'success', data: { profiles } });
  } catch (error) {
    next(new AppError('Failed to fetch pricing profiles', 500));
  }
};

exports.savePricingProfile = async (req, res, next) => {
  try {
    const { id, name, isDefault, machineId, companyId, bwSingleRate, bwDuplexRate, colorSingleRate, colorDuplexRate, a4Multiplier, a3Multiplier, legalMultiplier, glossySurcharge, minOrderAmount, convenienceFee, gstEnabled, gstRatePercent, isTaxInclusive, isActive } = req.body;
    const data = {
      name: name || 'Standard Kiosk Pricing',
      isDefault: Boolean(isDefault),
      machineId: machineId || null,
      companyId: companyId || null,
      bwSingleRate: bwSingleRate !== undefined ? Number(bwSingleRate) : 2.0,
      bwDuplexRate: bwDuplexRate !== undefined ? Number(bwDuplexRate) : 3.0,
      colorSingleRate: colorSingleRate !== undefined ? Number(colorSingleRate) : 10.0,
      colorDuplexRate: colorDuplexRate !== undefined ? Number(colorDuplexRate) : 18.0,
      a4Multiplier: a4Multiplier !== undefined ? Number(a4Multiplier) : 1.0,
      a3Multiplier: a3Multiplier !== undefined ? Number(a3Multiplier) : 2.0,
      legalMultiplier: legalMultiplier !== undefined ? Number(legalMultiplier) : 1.2,
      glossySurcharge: glossySurcharge !== undefined ? Number(glossySurcharge) : 0.0,
      minOrderAmount: minOrderAmount !== undefined ? Number(minOrderAmount) : 1.0,
      convenienceFee: convenienceFee !== undefined ? Number(convenienceFee) : 0.0,
      gstEnabled: Boolean(gstEnabled),
      gstRatePercent: gstRatePercent !== undefined ? Number(gstRatePercent) : 18.0,
      isTaxInclusive: isTaxInclusive !== undefined ? Boolean(isTaxInclusive) : true,
      isActive: isActive !== undefined ? Boolean(isActive) : true
    };

    let profile;
    if (id) {
      profile = await prisma.printPricingProfile.update({ where: { id }, data });
    } else {
      profile = await prisma.printPricingProfile.create({ data });
    }

    res.status(200).json({ status: 'success', data: { profile } });
  } catch (error) {
    next(new AppError('Failed to save pricing profile: ' + error.message, 400));
  }
};

exports.getBusinessProfile = async (req, res, next) => {
  try {
    const { getBusinessProfile } = require('../../services/invoice.service');
    const profile = await getBusinessProfile(req.user?.companyId);
    res.status(200).json({ status: 'success', data: { profile } });
  } catch (error) {
    next(new AppError('Failed to fetch business profile', 500));
  }
};

exports.saveBusinessProfile = async (req, res, next) => {
  try {
    const { legalName, tradeName, gstin, panNumber, sacCode, supportEmail, supportPhone, addressLine1, addressLine2, city, state, stateCode, pincode, invoicePrefix, termsAndConditions } = req.body;

    const data = {
      legalName: legalName || 'PrintGo Self-Service Kiosks',
      tradeName: tradeName || 'PrintGo',
      gstin: gstin ? gstin.trim().toUpperCase() : null,
      panNumber: panNumber ? panNumber.trim().toUpperCase() : null,
      sacCode: sacCode || '9989',
      supportEmail: supportEmail || null,
      supportPhone: supportPhone || null,
      addressLine1: addressLine1 || null,
      addressLine2: addressLine2 || null,
      city: city || 'Hyderabad',
      state: state || 'Telangana',
      stateCode: stateCode || '36',
      pincode: pincode || null,
      invoicePrefix: invoicePrefix || 'INV-PG-',
      termsAndConditions: termsAndConditions || null
    };

    const existing = await prisma.businessProfile.findFirst();
    let profile;
    if (existing) {
      profile = await prisma.businessProfile.update({ where: { id: existing.id }, data });
    } else {
      profile = await prisma.businessProfile.create({ data });
    }

    res.status(200).json({ status: 'success', data: { profile } });
  } catch (error) {
    next(new AppError('Failed to save business profile: ' + error.message, 400));
  }
};

// ==============================================
// REFUNDS MANAGEMENT (Phase 4A & 4E)
// ==============================================

exports.getRefunds = async (req, res, next) => {
  try {
    const refundService = require('../../services/refund.service');
    const result = await refundService.getRefunds({
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status,
      paymentId: req.query.paymentId,
      user: req.user
    });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

exports.getRefundById = async (req, res, next) => {
  try {
    const refundService = require('../../services/refund.service');
    const refund = await refundService.getRefundById(req.params.id, req.user);
    res.status(200).json({ success: true, refund });
  } catch (error) {
    next(error);
  }
};

exports.createRefund = async (req, res, next) => {
  try {
    const refundService = require('../../services/refund.service');
    const { paymentId, amount, reason, idempotencyKey } = req.body;

    if (!paymentId) {
      return res.status(400).json({ success: false, error: 'paymentId is required' });
    }

    const refund = await refundService.createRefund({
      paymentId,
      amount,
      reason,
      idempotencyKey,
      user: req.user,
      initiatedBy: req.user?.id || 'ADMIN'
    });

    res.status(201).json({ success: true, refund });
  } catch (error) {
    next(error);
  }
};

// ==============================================
// RECONCILIATION ENGINE (Phase 4D & 4E)
// ==============================================

exports.getReconciliationRecords = async (req, res, next) => {
  try {
    const reconciliationService = require('../../services/reconciliation.service');
    const result = await reconciliationService.getReconciliationRecords({
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status,
      resolved: req.query.resolved
    });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

exports.getReconciliationById = async (req, res, next) => {
  try {
    const prisma = require('../../utils/prisma');
    const record = await prisma.reconciliationRecord.findUnique({
      where: { id: req.params.id },
      include: { payment: true }
    });
    if (!record) return res.status(404).json({ success: false, error: 'Reconciliation record not found' });
    res.status(200).json({ success: true, record });
  } catch (error) {
    next(error);
  }
};

exports.runReconciliation = async (req, res, next) => {
  try {
    const reconciliationService = require('../../services/reconciliation.service');
    const dryRun = req.body.dryRun === true;
    const limit = req.body.limit ? Number(req.body.limit) : 50;

    const result = await reconciliationService.runReconciliation({ limit, dryRun });
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

exports.resolveReconciliation = async (req, res, next) => {
  try {
    const reconciliationService = require('../../services/reconciliation.service');
    const { resolutionNotes } = req.body;

    const updated = await reconciliationService.resolveDiscrepancy(req.params.id, {
      resolutionNotes,
      user: req.user
    });

    res.status(200).json({ success: true, record: updated });
  } catch (error) {
    next(error);
  }
};

// ==============================================
// PHASE 5: ENTERPRISE ANALYTICS & DASHBOARD APIS
// ==============================================

exports.getOverviewStats = async (req, res, next) => {
  try {
    const adminAnalytics = require('../../services/adminAnalytics.service');
    const result = await adminAnalytics.getOverviewStats(req.user, req.query);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.getSalesCharts = async (req, res, next) => {
  try {
    const adminAnalytics = require('../../services/adminAnalytics.service');
    const result = await adminAnalytics.getSalesChartsData(req.user, req.query);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

exports.getPayments = async (req, res, next) => {
  try {
    const adminAnalytics = require('../../services/adminAnalytics.service');
    const result = await adminAnalytics.getPayments(req.user, req.query);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

exports.getInvoices = async (req, res, next) => {
  try {
    const adminAnalytics = require('../../services/adminAnalytics.service');
    const result = await adminAnalytics.getInvoices(req.user, req.query);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

exports.getCreditNotes = async (req, res, next) => {
  try {
    const adminAnalytics = require('../../services/adminAnalytics.service');
    const result = await adminAnalytics.getCreditNotes(req.user, req.query);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

exports.getCustomers = async (req, res, next) => {
  try {
    const adminAnalytics = require('../../services/adminAnalytics.service');
    const result = await adminAnalytics.getCustomers(req.user, req.query);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

exports.getOperators = async (req, res, next) => {
  try {
    const adminAnalytics = require('../../services/adminAnalytics.service');
    const result = await adminAnalytics.getOperators(req.user);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

exports.getAuditLogs = async (req, res, next) => {
  try {
    const adminAnalytics = require('../../services/adminAnalytics.service');
    const result = await adminAnalytics.getAuditLogs(req.user, req.query);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

exports.exportReportCsv = async (req, res, next) => {
  try {
    const adminAnalytics = require('../../services/adminAnalytics.service');
    const reportType = req.params.type || 'sales';
    const csvData = await adminAnalytics.exportReportCsv(req.user, reportType, req.query);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="printgo_${reportType}_report_${Date.now()}.csv"`);
    res.status(200).send(csvData);
  } catch (error) {
    next(error);
  }
};
