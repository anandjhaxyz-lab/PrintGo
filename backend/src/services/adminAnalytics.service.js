/**
 * Admin Analytics & Reporting Service
 * Phase 5: Authoritative Financial Aggregation, Sales Analytics, and Multi-Tenant Reports
 */

const prisma = require('../utils/prisma');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

/**
 * Parses date range filter from query parameters.
 */
const parseDateRange = (period, customStart, customEnd) => {
  const now = new Date();
  let startDate = new Date();
  let endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000); // end of current day buffer

  switch (period) {
    case 'today':
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
      break;
    case 'yesterday':
      startDate.setDate(startDate.getDate() - 1);
      startDate.setHours(0, 0, 0, 0);
      endDate.setDate(endDate.getDate() - 1);
      endDate.setHours(23, 59, 59, 999);
      break;
    case '7d':
      startDate.setDate(startDate.getDate() - 7);
      startDate.setHours(0, 0, 0, 0);
      break;
    case '30d':
      startDate.setDate(startDate.getDate() - 30);
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'custom':
      if (customStart) startDate = new Date(customStart);
      if (customEnd) {
        endDate = new Date(customEnd);
        endDate.setHours(23, 59, 59, 999);
      }
      break;
    default:
      // Default to last 30 days for overview if not specified
      startDate.setDate(startDate.getDate() - 30);
      startDate.setHours(0, 0, 0, 0);
  }

  return { startDate, endDate };
};

/**
 * Returns tenant scoping condition based on user role.
 */
const getTenantFilter = (user) => {
  if (!user || user.role === 'SUPERADMIN') return {};
  if (user.role === 'FRANCHISEE') {
    return { companyId: user.companyId };
  }
  return { companyId: user.companyId || 'UNKNOWN' };
};

/**
 * Overview KPIs with authoritative server-side financial calculations.
 */
const getOverviewStats = async (user, query = {}) => {
  const { period = '30d', startDate: cStart, endDate: cEnd } = query;
  const { startDate, endDate } = parseDateRange(period, cStart, cEnd);

  // Machine tenant filter
  const machineWhere = {};
  if (user && user.role === 'FRANCHISEE') {
    machineWhere.companyId = user.companyId;
  }

  // Fetch machines to determine active/offline counts & tenant machine IDs
  const machines = await prisma.machine.findMany({
    where: machineWhere,
    select: { id: true, status: true, healthStatus: true }
  });

  const machineIds = machines.map(m => m.id);
  const activePrinters = machines.filter(m => m.status === 'ACTIVE').length;
  const offlinePrinters = machines.filter(m => m.status !== 'ACTIVE' || m.healthStatus === 'OFFLINE').length;

  // Jobs filter
  const jobWhere = {
    createdAt: { gte: startDate, lte: endDate }
  };
  if (user && user.role === 'FRANCHISEE') {
    jobWhere.machineId = { in: machineIds };
  }

  // Fetch jobs in period
  const jobs = await prisma.printJob.findMany({
    where: jobWhere,
    select: {
      id: true,
      status: true,
      cost: true,
      color: true,
      duplex: true,
      paperSize: true,
      paperType: true,
      copies: true,
      pagesToPrint: true,
      createdAt: true,
      paymentId: true,
      isTest: true,
      payment: {
        select: {
          id: true,
          status: true,
          amount: true,
          paymentMethod: true,
          gatewayOrderId: true,
          paymentGroup: true
        }
      }
    }
  });

  const totalOrders = jobs.length;
  const completedJobs = jobs.filter(j => j.status === 'COMPLETED').length;
  const printingJobs = jobs.filter(j => j.status === 'PRINTING').length;
  const failedJobs = jobs.filter(j => j.status === 'FAILED' || j.status === 'CANCELLED').length;
  const pendingPaymentJobs = jobs.filter(j => j.status === 'PENDING_PAYMENT').length;

  // Refunds filter
  const refundWhere = {
    createdAt: { gte: startDate, lte: endDate },
    status: 'SUCCESS'
  };
  if (user && user.role === 'FRANCHISEE') {
    refundWhere.payment = {
      printJobs: { some: { machineId: { in: machineIds } } }
    };
  }

  const successfulRefunds = await prisma.refund.findMany({
    where: refundWhere,
    select: { amount: true }
  });

  const totalRefundAmount = successfulRefunds.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  // Separate real vs demo revenue from verified payments
  let grossRevenue = 0;
  let demoRevenue = 0;
  let successfulPaymentsCount = 0;
  let pendingPaymentsCount = 0;

  const countedPaymentIds = new Set();

  for (const job of jobs) {
    if (!job.payment || countedPaymentIds.has(job.payment.id)) continue;
    countedPaymentIds.add(job.payment.id);

    const isDemo = job.isTest ||
                   job.payment.paymentMethod === 'demo' ||
                   job.payment.paymentGroup === 'simulated' ||
                   (job.payment.gatewayOrderId && job.payment.gatewayOrderId.startsWith('demo_order_'));

    if (job.payment.status === 'SUCCESS') {
      successfulPaymentsCount++;
      if (isDemo) {
        demoRevenue += Number(job.payment.amount) || 0;
      } else {
        grossRevenue += Number(job.payment.amount) || 0;
      }
    } else if (job.payment.status === 'PENDING') {
      pendingPaymentsCount++;
    }
  }

  // Round amounts to 2 decimals
  grossRevenue = Math.round(grossRevenue * 100) / 100;
  demoRevenue = Math.round(demoRevenue * 100) / 100;
  const roundedRefunds = Math.round(totalRefundAmount * 100) / 100;
  const netRevenue = Math.round((grossRevenue - roundedRefunds) * 100) / 100;
  const aov = successfulPaymentsCount > 0 
    ? Math.round((grossRevenue / successfulPaymentsCount) * 100) / 100 
    : 0;

  return {
    period,
    dateRange: { startDate, endDate },
    orders: {
      total: totalOrders,
      completed: completedJobs,
      printing: printingJobs,
      failed: failedJobs,
      pendingPayment: pendingPaymentJobs
    },
    financials: {
      grossCollections: grossRevenue,
      demoCollections: demoRevenue,
      totalRefunds: roundedRefunds,
      netCollections: netRevenue,
      successfulPayments: successfulPaymentsCount,
      pendingPayments: pendingPaymentsCount,
      averageOrderValue: aov,
      currency: 'INR'
    },
    hardware: {
      totalMachines: machines.length,
      activePrinters,
      offlinePrinters
    }
  };
};

/**
 * Generates detailed sales & usage analytics for charts and breakdown tables.
 */
const getSalesChartsData = async (user, query = {}) => {
  const { period = '30d', startDate: cStart, endDate: cEnd } = query;
  const { startDate, endDate } = parseDateRange(period, cStart, cEnd);

  const machineWhere = {};
  if (user && user.role === 'FRANCHISEE') {
    machineWhere.companyId = user.companyId;
  }

  const machines = await prisma.machine.findMany({
    where: machineWhere,
    select: { id: true, name: true, location: true }
  });
  const machineMap = new Map(machines.map(m => [m.id, m.name]));
  const machineIds = machines.map(m => m.id);

  const jobWhere = {
    createdAt: { gte: startDate, lte: endDate }
  };
  if (user && user.role === 'FRANCHISEE') {
    jobWhere.machineId = { in: machineIds };
  }

  const jobs = await prisma.printJob.findMany({
    where: jobWhere,
    include: {
      payment: true,
      machine: true
    },
    orderBy: { createdAt: 'asc' }
  });

  // Time-series daily trend
  const dailyMap = {};
  const paymentMethodsMap = {};
  const printModesMap = {
    bwSingle: 0,
    bwDuplex: 0,
    colorSingle: 0,
    colorDuplex: 0
  };
  const paperSizesMap = {};
  const machineRevenueMap = {};

  for (const job of jobs) {
    const dayKey = job.createdAt.toISOString().slice(0, 10);
    if (!dailyMap[dayKey]) {
      dailyMap[dayKey] = { date: dayKey, grossRevenue: 0, demoRevenue: 0, orders: 0, completed: 0 };
    }
    dailyMap[dayKey].orders += 1;
    if (job.status === 'COMPLETED') dailyMap[dayKey].completed += 1;

    // Financial check
    if (job.payment && job.payment.status === 'SUCCESS') {
      const isDemo = job.isTest ||
                     job.payment.paymentMethod === 'demo' ||
                     job.payment.paymentGroup === 'simulated' ||
                     (job.payment.gatewayOrderId && job.payment.gatewayOrderId.startsWith('demo_order_'));

      const amount = Number(job.payment.amount) || 0;
      if (isDemo) {
        dailyMap[dayKey].demoRevenue += amount;
      } else {
        dailyMap[dayKey].grossRevenue += amount;

        // Machine breakdown for real revenue
        const mName = job.machine?.name || 'Unassigned Kiosk';
        machineRevenueMap[mName] = (machineRevenueMap[mName] || 0) + amount;
      }

      // Payment method
      const method = isDemo ? 'Demo Mode' : (job.payment.paymentMethod || 'UPI');
      paymentMethodsMap[method] = (paymentMethodsMap[method] || 0) + 1;
    }

    // Print modes
    const isColor = job.color === 'color';
    const isDuplex = job.duplex === 'double';
    if (!isColor && !isDuplex) printModesMap.bwSingle += 1;
    else if (!isColor && isDuplex) printModesMap.bwDuplex += 1;
    else if (isColor && !isDuplex) printModesMap.colorSingle += 1;
    else if (isColor && isDuplex) printModesMap.colorDuplex += 1;

    // Paper size
    const pSize = job.paperSize || 'A4';
    paperSizesMap[pSize] = (paperSizesMap[pSize] || 0) + 1;
  }

  // Convert daily map to sorted array
  const dailyTrend = Object.values(dailyMap).map(d => ({
    ...d,
    grossRevenue: Math.round(d.grossRevenue * 100) / 100,
    demoRevenue: Math.round(d.demoRevenue * 100) / 100
  })).sort((a, b) => a.date.localeCompare(b.date));

  // Payment methods chart data
  const paymentMethods = Object.entries(paymentMethodsMap).map(([name, count]) => ({
    name,
    count
  }));

  // Machine revenue chart data
  const machineRevenue = Object.entries(machineRevenueMap).map(([name, revenue]) => ({
    name,
    revenue: Math.round(revenue * 100) / 100
  }));

  // Paper sizes chart data
  const paperSizes = Object.entries(paperSizesMap).map(([name, count]) => ({
    name,
    count
  }));

  return {
    period,
    dailyTrend,
    paymentMethods,
    printModes: [
      { name: 'B&W Single-Sided', count: printModesMap.bwSingle },
      { name: 'B&W Duplex', count: printModesMap.bwDuplex },
      { name: 'Colour Single-Sided', count: printModesMap.colorSingle },
      { name: 'Colour Duplex', count: printModesMap.colorDuplex }
    ],
    paperSizes,
    machineRevenue
  };
};

/**
 * Returns paginated payments with rich filters and tenant isolation.
 */
const getPayments = async (user, query = {}) => {
  const { page = 1, limit = 20, status, search, paymentMethod, isDemo, startDate, endDate } = query;
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

  const where = {};
  if (status) where.status = status;
  if (paymentMethod) where.paymentMethod = paymentMethod;

  if (isDemo !== undefined) {
    if (isDemo === 'true' || isDemo === true) {
      where.OR = [
        { paymentMethod: 'demo' },
        { paymentGroup: 'simulated' },
        { gatewayOrderId: { startsWith: 'demo_order_' } }
      ];
    } else {
      where.NOT = [
        { paymentMethod: 'demo' },
        { paymentGroup: 'simulated' },
        { gatewayOrderId: { startsWith: 'demo_order_' } }
      ];
    }
  }

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  if (search) {
    where.OR = [
      { gatewayOrderId: { contains: search, mode: 'insensitive' } },
      { gatewayPaymentId: { contains: search, mode: 'insensitive' } },
      { id: { contains: search, mode: 'insensitive' } }
    ];
  }

  // Tenant Isolation
  if (user && user.role === 'FRANCHISEE') {
    where.printJobs = {
      some: { machine: { companyId: user.companyId } }
    };
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        printJobs: {
          select: {
            id: true,
            shortId: true,
            status: true,
            machine: { select: { id: true, name: true } },
            document: { select: { originalName: true } }
          }
        },
        refunds: true
      }
    }),
    prisma.payment.count({ where })
  ]);

  const sanitized = payments.map(p => {
    const isSimulated = p.paymentMethod === 'demo' ||
                        p.paymentGroup === 'simulated' ||
                        (p.gatewayOrderId && p.gatewayOrderId.startsWith('demo_order_'));
    return {
      ...p,
      isDemo: Boolean(isSimulated)
    };
  });

  return {
    success: true,
    payments: sanitized,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit))
    }
  };
};

/**
 * Returns paginated invoices with tenant isolation and search.
 */
const getInvoices = async (user, query = {}) => {
  const { page = 1, limit = 20, status, search, startDate, endDate } = query;
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

  const where = {};
  if (status) where.status = status;

  if (startDate || endDate) {
    where.issuedAt = {};
    if (startDate) where.issuedAt.gte = new Date(startDate);
    if (endDate) where.issuedAt.lte = new Date(endDate);
  }

  if (search) {
    where.OR = [
      { invoiceNumber: { contains: search, mode: 'insensitive' } },
      { sellerName: { contains: search, mode: 'insensitive' } },
      { buyerPhone: { contains: search, mode: 'insensitive' } }
    ];
  }

  // Tenant isolation
  if (user && user.role === 'FRANCHISEE') {
    where.printJob = {
      machine: { companyId: user.companyId }
    };
  }

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { issuedAt: 'desc' },
      include: {
        printJob: {
          select: {
            id: true,
            shortId: true,
            machine: { select: { name: true, location: true } }
          }
        },
        creditNotes: true
      }
    }),
    prisma.invoice.count({ where })
  ]);

  return {
    success: true,
    invoices,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit))
    }
  };
};

/**
 * Returns paginated credit notes with tenant isolation.
 */
const getCreditNotes = async (user, query = {}) => {
  const { page = 1, limit = 20, search, startDate, endDate } = query;
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

  const where = {};
  if (startDate || endDate) {
    where.issuedAt = {};
    if (startDate) where.issuedAt.gte = new Date(startDate);
    if (endDate) where.issuedAt.lte = new Date(endDate);
  }

  if (search) {
    where.OR = [
      { creditNoteNumber: { contains: search, mode: 'insensitive' } },
      { invoice: { invoiceNumber: { contains: search, mode: 'insensitive' } } }
    ];
  }

  if (user && user.role === 'FRANCHISEE') {
    where.invoice = {
      printJob: { machine: { companyId: user.companyId } }
    };
  }

  const [creditNotes, total] = await Promise.all([
    prisma.creditNote.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { issuedAt: 'desc' },
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            totalAmount: true,
            status: true
          }
        },
        refund: {
          select: {
            id: true,
            gatewayRefundId: true,
            status: true
          }
        }
      }
    }),
    prisma.creditNote.count({ where })
  ]);

  return {
    success: true,
    creditNotes,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit))
    }
  };
};

/**
 * Customer directory aggregated from completed print jobs.
 */
const getCustomers = async (user, query = {}) => {
  const { page = 1, limit = 20, search } = query;
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

  const where = {};
  if (search) {
    where.OR = [
      { email: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } }
    ];
  }

  if (user && user.role === 'FRANCHISEE') {
    where.printJobs = {
      some: { machine: { companyId: user.companyId } }
    };
  }

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      skip,
      take: Number(limit),
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { printJobs: true } }
      }
    }),
    prisma.customer.count({ where })
  ]);

  return {
    success: true,
    customers,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit))
    }
  };
};

/**
 * Operator / User listing with tenant protection.
 */
const getOperators = async (user) => {
  const where = {};
  if (user && user.role === 'FRANCHISEE') {
    where.companyId = user.companyId;
  }

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      companyId: true,
      company: { select: { id: true, name: true } },
      createdAt: true
    },
    orderBy: { createdAt: 'desc' }
  });

  return { success: true, operators: users };
};

/**
 * Unified audit log feed combining ActivityLog and AuditLog with sensitive redaction.
 */
const getAuditLogs = async (user, query = {}) => {
  const { page = 1, limit = 30 } = query;
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

  const [activityLogs, total] = await Promise.all([
    prisma.activityLog.findMany({
      skip,
      take: Number(limit),
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { name: true, email: true, role: true } },
        machine: { select: { name: true, location: true } }
      }
    }),
    prisma.activityLog.count()
  ]);

  // Redact any possible credentials or secrets
  const sanitized = activityLogs.map(log => {
    let details = log.details || '';
    details = details.replace(/password[:=]\s*[^\s,]+/gi, 'password=REDACTED');
    details = details.replace(/secret[:=]\s*[^\s,]+/gi, 'secret=REDACTED');
    details = details.replace(/token[:=]\s*[^\s,]+/gi, 'token=REDACTED');
    return {
      ...log,
      details
    };
  });

  return {
    success: true,
    logs: sanitized,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit))
    }
  };
};

/**
 * Generates CSV string for various report types respecting tenant boundaries.
 */
const exportReportCsv = async (user, reportType, query = {}) => {
  const { period = '30d', startDate: cStart, endDate: cEnd } = query;
  const { startDate, endDate } = parseDateRange(period, cStart, cEnd);

  let csvContent = '';

  switch (reportType) {
    case 'sales': {
      const { dailyTrend } = await getSalesChartsData(user, { period, startDate: cStart, endDate: cEnd });
      csvContent = 'Date,Gross Collections (INR),Demo Collections (INR),Total Orders,Completed Orders\n';
      dailyTrend.forEach(row => {
        csvContent += `"${row.date}",${row.grossRevenue},${row.demoRevenue},${row.orders},${row.completed}\n`;
      });
      break;
    }
    case 'jobs': {
      const jobWhere = { createdAt: { gte: startDate, lte: endDate } };
      if (user && user.role === 'FRANCHISEE') {
        jobWhere.machine = { companyId: user.companyId };
      }
      const jobs = await prisma.printJob.findMany({
        where: jobWhere,
        include: { machine: true, document: true, payment: true },
        orderBy: { createdAt: 'desc' }
      });
      csvContent = 'Job ID,Document Name,Machine,Pages,Color,Duplex,Cost (INR),Print Status,Payment Status,Is Test,Date\n';
      jobs.forEach(j => {
        csvContent += `"${j.shortId}","${(j.document?.originalName || '').replace(/"/g, '""')}","${j.machine?.name || 'N/A'}",${j.pagesToPrint},"${j.color}","${j.duplex}",${j.cost},"${j.status}","${j.payment?.status || 'UNPAID'}",${Boolean(j.isTest)},"${j.createdAt.toISOString()}"\n`;
      });
      break;
    }
    case 'payments': {
      const payWhere = { createdAt: { gte: startDate, lte: endDate } };
      if (user && user.role === 'FRANCHISEE') {
        payWhere.printJobs = { some: { machine: { companyId: user.companyId } } };
      }
      const payments = await prisma.payment.findMany({
        where: payWhere,
        orderBy: { createdAt: 'desc' }
      });
      csvContent = 'Payment ID,Gateway Order ID,Amount (INR),Status,Method,Is Demo,Date\n';
      payments.forEach(p => {
        const isDemo = p.paymentMethod === 'demo' || p.paymentGroup === 'simulated' || (p.gatewayOrderId && p.gatewayOrderId.startsWith('demo_order_'));
        csvContent += `"${p.id}","${p.gatewayOrderId || 'N/A'}",${p.amount},"${p.status}","${p.paymentMethod || 'N/A'}",${Boolean(isDemo)},"${p.createdAt.toISOString()}"\n`;
      });
      break;
    }
    case 'refunds': {
      const refWhere = { createdAt: { gte: startDate, lte: endDate } };
      if (user && user.role === 'FRANCHISEE') {
        refWhere.payment = { printJobs: { some: { machine: { companyId: user.companyId } } } };
      }
      const refunds = await prisma.refund.findMany({
        where: refWhere,
        orderBy: { createdAt: 'desc' }
      });
      csvContent = 'Refund ID,Gateway Refund ID,Payment ID,Amount (INR),Status,Reason,Date\n';
      refunds.forEach(r => {
        csvContent += `"${r.id}","${r.gatewayRefundId || r.cfRefundId || 'N/A'}","${r.paymentId}",${r.amount},"${r.status}","${(r.reason || '').replace(/"/g, '""')}","${r.createdAt.toISOString()}"\n`;
      });
      break;
    }
    case 'invoices': {
      const invWhere = { issuedAt: { gte: startDate, lte: endDate } };
      if (user && user.role === 'FRANCHISEE') {
        invWhere.printJob = { machine: { companyId: user.companyId } };
      }
      const invoices = await prisma.invoice.findMany({
        where: invWhere,
        orderBy: { issuedAt: 'desc' }
      });
      csvContent = 'Invoice Number,Taxable Amount (INR),CGST (INR),SGST (INR),Total Amount (INR),Status,Is Demo,Issued Date\n';
      invoices.forEach(inv => {
        csvContent += `"${inv.invoiceNumber}",${inv.taxableAmount},${inv.cgstAmount},${inv.sgstAmount},${inv.totalAmount},"${inv.status}",${inv.isDemo},"${inv.issuedAt.toISOString()}"\n`;
      });
      break;
    }
    default:
      throw new AppError(`Unsupported report type: ${reportType}`, 400);
  }

  return csvContent;
};

module.exports = {
  getOverviewStats,
  getSalesChartsData,
  getPayments,
  getInvoices,
  getCreditNotes,
  getCustomers,
  getOperators,
  getAuditLogs,
  exportReportCsv
};
