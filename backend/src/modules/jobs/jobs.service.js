const prisma = require('../../utils/prisma');
const crypto = require('crypto');
const AppError = require('../../utils/AppError');
const logger = require('../../utils/logger');
const { DEFAULT_PAYMENT_MODE } = require('../../constants/paymentModes');
const { isValidJobTransition, PRINT_JOB_TRANSITIONS } = require('../../utils/stateMachine');

const generateShortId = () => crypto.randomBytes(4).toString('hex');

const getAllJobs = async (user, query = {}) => {
  const { page = 1, limit = 100, status, paymentStatus, machineId, color, duplex, search, startDate, endDate, isTest } = query;
  const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

  const where = {};
  if (user && user.role !== 'SUPERADMIN') {
    where.machine = { companyId: user.companyId };
  }
  if (status) where.status = status;
  if (machineId) where.machineId = machineId;
  if (color) where.color = color;
  if (duplex) where.duplex = duplex;
  if (isTest !== undefined && isTest !== '') {
    where.isTest = isTest === 'true' || isTest === true;
  }

  if (paymentStatus) {
    where.payment = { status: paymentStatus };
  }

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  if (search) {
    where.OR = [
      { shortId: { contains: search, mode: 'insensitive' } },
      { document: { originalName: { contains: search, mode: 'insensitive' } } }
    ];
  }

  const [jobs, total] = await Promise.all([
    prisma.printJob.findMany({
      where,
      skip,
      take: Number(limit),
      include: {
        document: true,
        machine: true,
        customer: true,
        payment: true,
        invoice: true,
        printHistory: { orderBy: { completedAt: 'desc' } }
      },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.printJob.count({ where })
  ]);

  return {
    jobs,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      pages: Math.ceil(total / Number(limit))
    }
  };
};

const getJobByShortId = async (shortId, user = null) => {
  const job = await prisma.printJob.findUnique({
    where: { shortId },
    include: {
      document: true,
      machine: true,
      payment: true,
      invoice: true,
      printHistory: { orderBy: { completedAt: 'desc' } }
    }
  });
  if (!job) {
    throw new AppError('Job not found', 404);
  }

  // P2-002: Multi-tenancy check
  if (user && user.role !== 'SUPERADMIN') {
    if (!job.machine || job.machine.companyId !== user.companyId) {
      throw new AppError('Access denied: Job belongs to another company or is unassigned', 403);
    }
  }

  return job;
};

const createJob = async (jobData) => {
  const { file, settings, encryptedKey, iv } = jobData;
  let resolvedMachineId = jobData.machineId || null;
  let resolvedPrinterDeviceId = null;
  let resolvedPrinterWindowsQueueName = null;
  let resolvedPaymentMode = jobData.paymentMode;

  // A signed session token identifies the session; the database remains the
  // authority for Machine and child PrinterDevice binding. Ignore any client
  // supplied printerDeviceId and re-check approval immediately before job creation.
  if (jobData.sessionId) {
    const sessionRecord = await prisma.session.findUnique({
      where: { code: jobData.sessionId },
      select: {
        machineId: true,
        printerDeviceId: true,
        paymentMode: true
      }
    });

    if (!sessionRecord || !sessionRecord.machineId) {
      throw new AppError('Customer session is not bound to a valid printer.', 403);
    }
    if (resolvedMachineId && resolvedMachineId !== sessionRecord.machineId) {
      throw new AppError('Session Machine binding mismatch. Print job creation was rejected.', 403);
    }

    resolvedMachineId = sessionRecord.machineId;
    resolvedPaymentMode = sessionRecord.paymentMode || resolvedPaymentMode;

    if (sessionRecord.printerDeviceId) {
      const device = await prisma.printerDevice.findUnique({
        where: { id: sessionRecord.printerDeviceId },
        select: {
          id: true,
          machineId: true,
          status: true,
          approvedAt: true,
          windowsPrinterName: true,
          isDefault: true
        }
      });
      if (!device || device.machineId !== resolvedMachineId) {
        throw new AppError('Session physical printer mapping does not belong to the session Machine.', 403);
      }
      const isLegacyPlaceholder = Boolean(
        device.isDefault === true &&
        device.status === 'DISCOVERY_REQUIRED' &&
        !device.approvedAt &&
        !device.windowsPrinterName
      );

      // Phase 1 backfilled historic Machine QR sessions to an unbound primary
      // placeholder. Preserve those legacy sessions as Machine-scoped jobs.
      if (!isLegacyPlaceholder) {
        if (process.env.ENABLE_MULTI_PRINTER_DISPATCH !== 'true') {
          throw new AppError('Multi-printer dispatch is currently disabled. Please use the primary printer.', 403);
        }
        if (
          device.status !== 'ACTIVE' ||
          !device.approvedAt ||
          !device.windowsPrinterName?.trim()
        ) {
          throw new AppError('The physical printer selected by this QR is no longer approved or active. Please contact shop staff.', 409);
        }
        resolvedPrinterDeviceId = device.id;
        resolvedPrinterWindowsQueueName = device.windowsPrinterName;
      }
    }
  }

  // Create document only after server-side session and physical printer checks.
  const document = await prisma.document.create({
    data: {
      originalName: file.originalName,
      filename: file.filename,
      mimetype: file.mimetype,
      size: file.size,
      pages: file.pages
    }
  });

  // Server-side price calculation with dynamic pricing and immutable snapshot
  const { calculatePrice } = require('../../services/pricing.service');
  const priceResult = await calculatePrice(settings, { pages: file.pages }, resolvedMachineId);
  const { cost, pagesToPrint, pricingSnapshot } = priceResult;
  if (jobData.sessionId) {
    pricingSnapshot.sessionId = jobData.sessionId;
  }

  // Use the session's immutable payment-mode snapshot; legacy non-session
  // jobs retain the Machine fallback.
  if (!resolvedPaymentMode && resolvedMachineId) {
    const machineRecord = await prisma.machine.findUnique({
      where: { id: resolvedMachineId },
      select: { paymentMode: true }
    });
    resolvedPaymentMode = machineRecord?.paymentMode;
  }
  const finalPaymentMode = resolvedPaymentMode || DEFAULT_PAYMENT_MODE;
  pricingSnapshot.paymentMode = finalPaymentMode;

  // Create job
  const newJob = await prisma.printJob.create({
    data: {
      shortId: generateShortId(),
      machineId: resolvedMachineId,
      printerDeviceId: resolvedPrinterDeviceId,
      printerWindowsQueueName: resolvedPrinterWindowsQueueName,
      documentId: document.id,
      cost,
      paymentMode: finalPaymentMode,
      color: settings.color,
      duplex: settings.duplex,
      copies: settings.copies,
      pagesToPrint,
      pageRangeType: settings.pageRangeType,
      customRange: settings.customRange || null,
      paperSize: settings.paperSize || 'A4',
      paperType: settings.paperType || 'plain',
      pricingSnapshot: JSON.stringify(pricingSnapshot),
      encryptedKey: encryptedKey || null,
      iv: iv || null
    },
    include: { document: true }
  });
  
  logger.info(`Job created with shortId ${newJob.shortId}, server-calculated cost: ₹${cost}`);
  return newJob;
};

const resolveAmbiguousJob = async (shortId, data = {}, user = null) => {
  const outcome = data.outcome || data.status;
  if (!outcome || !['COMPLETED', 'FAILED'].includes(outcome)) {
    throw new AppError('Ambiguous PRINTING jobs can only be resolved to COMPLETED or FAILED.', 400);
  }

  // Baseline job protection
  if (shortId === 'ab36197e') {
    throw new AppError('Historical baseline job ab36197e is protected and cannot be altered', 400);
  }

  const currentJob = await getJobByShortId(shortId, user);

  if (currentJob.status !== 'PRINTING') {
    throw new AppError(`Job ${shortId} is in status ${currentJob.status}, not PRINTING. Ambiguity resolution only applies to PRINTING jobs.`, 400);
  }

  // Role validation: Ordinary STAFF cannot resolve ambiguous printing jobs
  if (!user || !['SUPERADMIN', 'FRANCHISEE'].includes(user.role)) {
    throw new AppError('Ordinary STAFF status updates cannot resolve jobs in PRINTING status. Authorized Admin verification is required.', 403);
  }

  // Multi-tenancy check
  if (user.role !== 'SUPERADMIN' && currentJob.machine?.companyId !== user.companyId) {
    throw new AppError('Access denied: Job belongs to another company.', 403);
  }

  // Validate operator reason: minimum 10 non-whitespace characters, max 500
  const rawReason = data.reason || data.evidence;
  const operatorReason = typeof rawReason === 'string' ? rawReason.trim() : '';
  if (operatorReason.length < 10) {
    throw new AppError('An operator reason of at least 10 non-whitespace characters is required to resolve a PRINTING job.', 400);
  }
  if (operatorReason.length > 500) {
    throw new AppError('Operator reason cannot exceed 500 characters.', 400);
  }

  // Spooler-empty check & physical confirmation for COMPLETED
  if (outcome === 'COMPLETED') {
    if (data.spoolerEmptyOnly === true) {
      throw new AppError('Spooler-empty status alone is insufficient evidence. Authorized human physical verification confirming the customer document was printed is required to mark a job COMPLETED.', 400);
    }
    const hasExplicitPhysicalFlag = data.physicalConfirmation === true || data.physicalVerificationConfirmed === true;
    if (!hasExplicitPhysicalFlag) {
      throw new AppError('Authorized physical confirmation is required to mark a PRINTING job as COMPLETED.', 400);
    }
  }

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // Row lock the job record
    await tx.$queryRaw`SELECT "id" FROM "PrintJob" WHERE "id" = ${currentJob.id} FOR UPDATE`;

    // Re-read and validate current status after acquiring the row lock
    let lockedJob = null;
    if (typeof tx.printJob?.findUnique === 'function') {
      lockedJob = await tx.printJob.findUnique({
        where: { id: currentJob.id },
        include: {
          document: true,
          machine: true,
          payment: true,
          invoice: true
        }
      });
    }

    if (!lockedJob) {
      lockedJob = currentJob;
    }

    if (!lockedJob) {
      throw new AppError('Job record not found.', 404);
    }

    if (lockedJob.status !== 'PRINTING') {
      if (lockedJob.status === outcome) {
        // Idempotent: already resolved to this outcome by a concurrent operator
        logger.info(`Job ${shortId} was already resolved to ${outcome}; returning existing record idempotently`);
        return lockedJob;
      }
      throw new AppError(
        `Conflict: Job ${shortId} has already been resolved to '${lockedJob.status}'. Cannot overwrite with '${outcome}'.`,
        409
      );
    }

    const updatedJob = await tx.printJob.update({
      where: { id: currentJob.id },
      data: { status: outcome },
      include: {
        document: true,
        machine: true,
        payment: true,
        invoice: true
      }
    });

    // Create durable PrintHistory entry
    await tx.printHistory.create({
      data: {
        printJobId: currentJob.id,
        success: outcome === 'COMPLETED',
        errorDetails: outcome === 'COMPLETED'
          ? `Physical verification confirmed by operator: ${operatorReason}`
          : `Physical inspection failure resolved by operator: ${operatorReason}`,
        completedAt: now
      }
    });

    // Create durable ActivityLog entry using locked/current database state
    await tx.activityLog.create({
      data: {
        action: 'PRINT_JOB_STATUS_RESOLVED',
        details: JSON.stringify({
          jobId: currentJob.id,
          shortId: currentJob.shortId,
          previousStatus: lockedJob.status,
          newStatus: outcome,
          machineId: lockedJob.machineId,
          printerDeviceId: lockedJob.printerDeviceId || null,
          operatorId: user?.id || 'SYSTEM_OPERATOR',
          operatorRole: user?.role || 'UNKNOWN',
          operatorReason,
          physicalConfirmation: outcome === 'COMPLETED',
          timestamp: now.toISOString()
        }),
        userId: user?.id || null,
        machineId: lockedJob.machineId || null,
        ipAddress: data.ipAddress || null
      }
    });

    logger.info(`Job ${shortId} resolved from PRINTING to ${outcome} by ${user?.role || 'UNKNOWN'} (${user?.id || 'SYSTEM'})`);
    return updatedJob;
  }, { maxWait: 10000, timeout: 15000 });
};

const updateJobStatus = async (shortId, status, user = null, options = {}) => {
  // P2-002: Check permission first
  const currentJob = await getJobByShortId(shortId, user);

  // Historical guard: Job ab36197e must NEVER be modified
  if (shortId === 'ab36197e') {
    throw new AppError('Historical baseline job ab36197e is protected and cannot be altered', 400);
  }

  // 1. Enforce State Machine Transitions
  if (!isValidJobTransition(currentJob.status, status)) {
    const allowed = PRINT_JOB_TRANSITIONS[currentJob.status] || [];
    throw new AppError(
      `Invalid status transition from "${currentJob.status}" to "${status}". Allowed transitions: [${allowed.join(', ')}]`,
      400
    );
  }

  // 2. Special protection for ambiguous PRINTING jobs
  if (currentJob.status === 'PRINTING') {
    return resolveAmbiguousJob(shortId, {
      outcome: status,
      reason: options.reason || options.evidence,
      physicalConfirmation: options.physicalConfirmation,
      physicalVerificationConfirmed: options.physicalVerificationConfirmed,
      spoolerEmptyOnly: options.spoolerEmptyOnly,
      ipAddress: options.ipAddress
    }, user);
  }

  // 3. For other valid transitions (e.g. PENDING_PAYMENT -> WAITING, WAITING -> CANCELLED, FAILED -> CANCELLED)
  const job = await prisma.printJob.update({
    where: { shortId },
    data: { status }
  });
  logger.info(`Job ${shortId} status updated from ${currentJob.status} to ${status}`);
  return job;
};

module.exports = {
  getAllJobs,
  getJobByShortId,
  createJob,
  updateJobStatus,
  resolveAmbiguousJob
};
