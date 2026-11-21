const prisma = require('./utils/prisma');
const logger = require('./utils/logger');
const { isValidJobTransition } = require('./utils/stateMachine');
const { getMachineAvailability, computePrinterAvailability } = require('./services/printerAvailability.service');

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const {
  handlePrinterAgentHello,
  handlePrinterDeviceRegistryRequest,
  handlePrinterInventoryReport,
  handlePrinterDeviceTelemetry
} = require('./services/printerAgentProtocol.service');
const {
  verifyPrinterDeviceReport,
  authorizePrinterDeviceDispatch,
  renewPrinterDeviceDispatchLease,
  releasePrinterDeviceDispatchLease
} = require('./services/printerDeviceJobBinding.service');

// Module-level correlation and socket tracking for printer agents
const authenticatedPrinterSockets = new Map(); // machineId -> Set<Socket>
const pendingReconciliationsByRequestId = new Map(); // requestId -> correlationEntry
const RECONCILIATION_EXPIRY_MS = 60000;
const MAX_PENDING_PER_SOCKET = 50;
const MAX_GLOBAL_PENDING = 500;

const isSimulationAllowed = () => {
  if (process.env.ALLOW_SIMULATED_PRINTER === 'true') return true;
  const env = (process.env.NODE_ENV || '').toLowerCase();
  const appEnv = (process.env.APP_ENV || '').toLowerCase();
  return env === 'test' || env === 'development' || (env !== 'production' && appEnv !== 'production');
};

const pruneExpiredRequests = () => {
  const now = Date.now();
  for (const [reqId, entry] of pendingReconciliationsByRequestId.entries()) {
    const hasPendingJobs = entry.jobIds && entry.jobIds.size > 0;
    const hasValidatedJobs = entry.validatedCompletions && entry.validatedCompletions.size > 0;
    if (now - entry.createdAt > RECONCILIATION_EXPIRY_MS || (!hasPendingJobs && !hasValidatedJobs)) {
      pendingReconciliationsByRequestId.delete(reqId);
    }
  }
};

const pruneSocketRequests = (socket) => {
  if (!socket?.pendingReconciliations) return;
  const now = Date.now();
  for (const [reqId, entry] of socket.pendingReconciliations.entries()) {
    const hasPendingJobs = entry.jobIds && entry.jobIds.size > 0;
    const hasValidatedJobs = entry.validatedCompletions && entry.validatedCompletions.size > 0;
    if (now - entry.createdAt > RECONCILIATION_EXPIRY_MS || (!hasPendingJobs && !hasValidatedJobs)) {
      socket.pendingReconciliations.delete(reqId);
    }
  }
};

const registerReconciliationOnSocket = (socket, { requestId, jobIds, jobBindings }) => {
  if (!socket || !requestId || !jobIds) return null;
  pruneSocketRequests(socket);
  pruneExpiredRequests();

  const correlationEntry = {
    requestId,
    machineId: socket.machineId,
    jobIds: new Set(jobIds),
    jobBindings: jobBindings ? { ...jobBindings } : {},
    validatedCompletions: new Map(),
    consumedJobs: new Set(),
    createdAt: Date.now()
  };

  if (!socket.pendingReconciliations) {
    socket.pendingReconciliations = new Map();
  }

  if (socket.pendingReconciliations.size >= MAX_PENDING_PER_SOCKET) {
    const oldestKey = socket.pendingReconciliations.keys().next().value;
    if (oldestKey) socket.pendingReconciliations.delete(oldestKey);
  }
  socket.pendingReconciliations.set(requestId, correlationEntry);
  socket.activeReconciliation = correlationEntry;

  if (pendingReconciliationsByRequestId.size >= MAX_GLOBAL_PENDING) {
    const oldestKey = pendingReconciliationsByRequestId.keys().next().value;
    if (oldestKey) pendingReconciliationsByRequestId.delete(oldestKey);
  }
  pendingReconciliationsByRequestId.set(requestId, correlationEntry);

  return correlationEntry;
};

const requestPrinterReconciliation = (io, machineId, { requestId, jobIds, jobBindings } = {}) => {
  if (!machineId || !Array.isArray(jobIds) || jobIds.length === 0) {
    return { success: false, reason: 'INVALID_PARAMETERS' };
  }

  const effectiveRequestId = requestId || `rec_stuck_${machineId}_${Date.now()}_${crypto.randomUUID()}`;
  pruneExpiredRequests();

  const correlationEntry = {
    requestId: effectiveRequestId,
    machineId,
    jobIds: new Set(jobIds),
    jobBindings: jobBindings ? { ...jobBindings } : {},
    validatedCompletions: new Map(),
    consumedJobs: new Set(),
    createdAt: Date.now()
  };

  if (pendingReconciliationsByRequestId.size >= MAX_GLOBAL_PENDING) {
    const oldestKey = pendingReconciliationsByRequestId.keys().next().value;
    if (oldestKey) pendingReconciliationsByRequestId.delete(oldestKey);
  }
  pendingReconciliationsByRequestId.set(effectiveRequestId, correlationEntry);

  const sockets = authenticatedPrinterSockets.get(machineId);
  if (sockets && sockets.size > 0) {
    for (const socket of sockets) {
      if (!socket.pendingReconciliations) {
        socket.pendingReconciliations = new Map();
      }
      pruneSocketRequests(socket);
      if (socket.pendingReconciliations.size >= MAX_PENDING_PER_SOCKET) {
        const oldestKey = socket.pendingReconciliations.keys().next().value;
        if (oldestKey) socket.pendingReconciliations.delete(oldestKey);
      }
      socket.pendingReconciliations.set(effectiveRequestId, correlationEntry);
      socket.activeReconciliation = correlationEntry;
    }
  }

  if (io && typeof io.to === 'function') {
    io.to(`machine_${machineId}`).emit('reconcile_active_jobs', {
      requestId: effectiveRequestId,
      jobIds,
      jobBindings
    });
  }

  return {
    success: true,
    requestId: effectiveRequestId,
    socketCount: sockets ? sockets.size : 0
  };
};

const clearAllReconciliationState = () => {
  pendingReconciliationsByRequestId.clear();
  authenticatedPrinterSockets.clear();
};

const setupSockets = (io) => {
  // WebSocket Authentication Middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const machineKey = socket.handshake.auth?.machineKey;

      if (token) {
        // Authenticate Mobile/Kiosk via Session Token or Admin User Token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userType = decoded.type === 'session' ? 'session' : 'admin';
        if (decoded.type === 'session') {
          socket.sessionId = decoded.sessionId;
          socket.machineId = decoded.machineId; // Optional
        } else {
          socket.userId = decoded.id;
          socket.userRole = decoded.role;
          socket.companyId = decoded.companyId;
        }
        return next();
      } 
      
      if (machineKey) {
        // Validate machineKey against database
        const machine = await prisma.machine.findUnique({ where: { machineKey } });
        if (!machine) {
          logger.warn(`Printer agent connection rejected: invalid machineKey`);
          return next(new Error('Authentication error: Invalid machine key'));
        }
        if (machine.status === 'SUSPENDED') {
          logger.warn(`Printer agent connection rejected: machine ${machine.id} is suspended`);
          return next(new Error('Authentication error: Machine is suspended'));
        }
        socket.userType = 'printer';
        socket.machineId = machine.id;
        socket.machineName = machine.name;
        socket.companyId = machine.companyId;
        logger.info(`Printer agent authenticated: ${machine.name} (${machine.id})`);
        return next();
      }

      next(new Error('Authentication error: Missing token or machineKey'));
    } catch (err) {
      logger.error('Socket authentication failed:', err);
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    logger.info(`A client connected: ${socket.id} (Type: ${socket.userType})`);

    if (socket.userType === 'printer') {
      socket.join(`machine_${socket.machineId}`);
      if (!authenticatedPrinterSockets.has(socket.machineId)) {
        authenticatedPrinterSockets.set(socket.machineId, new Set());
      }
      authenticatedPrinterSockets.get(socket.machineId).add(socket);
      if (!socket.pendingReconciliations) {
        socket.pendingReconciliations = new Map();
      }

      // Notify the printer it successfully registered
      socket.emit('printer_registered_success', { machineId: socket.machineId, name: socket.machineName });

      // Broadcast fresh availability to customer sessions and admins
      (async () => {
        try {
          const availability = await getMachineAvailability(socket.machineId, prisma);
          if (availability) {
            io.to(`machine_${socket.machineId}`).emit('printer_status_update', availability);
            if (socket.companyId) {
              io.to(`company_${socket.companyId}`).emit('printer_status_update', availability);
            }
            io.to('superadmins').emit('printer_status_update', availability);
          }
        } catch (err) {
          logger.error('Error broadcasting machine availability on connect:', err);
        }
      })();

      // P4: Recovery System for dropped socket messages.
      // Reconcile active PRINTING jobs safely via agent journal rather than blindly re-emitting physical_print_job!
      (async () => {
        try {
          const stuckJobs = await prisma.printJob.findMany({
            where: {
              machineId: socket.machineId,
              status: 'PRINTING'
            },
            select: {
              shortId: true,
              printerDeviceId: true,
              printerWindowsQueueName: true
            }
          });
          
          if (stuckJobs.length > 0) {
            const jobIds = stuckJobs.map(j => j.shortId);
            const requestId = `rec_${socket.machineId}_${Date.now()}_${crypto.randomUUID()}`;
            const jobBindings = Object.fromEntries(stuckJobs.map((job) => [
              job.shortId,
              job.printerDeviceId ? {
                printerDeviceId: job.printerDeviceId,
                windowsPrinterName: job.printerWindowsQueueName || null
              } : null
            ]));
            registerReconciliationOnSocket(socket, {
              requestId,
              jobIds,
              jobBindings
            });
            logger.info(`Requesting reconciliation [ReqID: ${requestId}] for ${jobIds.length} active PRINTING job(s) from machine ${socket.machineId}: ${jobIds.join(', ')}`);
            socket.emit('reconcile_active_jobs', { requestId, jobIds, jobBindings });
          }
        } catch (e) {
          logger.error('Error recovering stuck jobs for printer:', e);
        }
      })();
    } else if (socket.userType === 'session' && socket.machineId) {
      socket.join(`machine_${socket.machineId}`);

      // Push current authoritative machine availability to newly joined customer session
      (async () => {
        try {
          const availability = await getMachineAvailability(socket.machineId, prisma);
          if (availability) {
            socket.emit('printer_status_update', availability);
          }
        } catch (err) {
          logger.error('Error sending availability to customer session socket:', err);
        }
      })();
    }

    // Admin users join their tenant company room; ONLY superadmins join global admin rooms
    if (socket.userType === 'admin') {
      if (socket.userRole === 'SUPERADMIN') {
        socket.join('admins');
        socket.join('superadmins');
      }
      if (socket.companyId) {
        socket.join(`company_${socket.companyId}`);
      }
    }

    socket.on('register_public_key', async ({ publicKey }) => {
      if (socket.userType === 'printer' && socket.machineId) {
        try {
          await prisma.machine.update({
            where: { id: socket.machineId },
            data: { publicKey }
          });
          logger.info(`RSA Public Key registered for machine ${socket.machineId}`);
        } catch (err) {
          logger.error(`Error registering public key for machine ${socket.machineId}:`, err);
        }
      }
    });

    // Backward-compatible Agent protocol negotiation. Older agents never emit
    // this event and continue using the existing Machine Key + single-printer flow.
    socket.on('printer_agent_hello', async (payload) => {
      await handlePrinterAgentHello({ socket, prisma, logger, payload });
    });

    // Device-bound print requests fetch a fresh authenticated registry so an
    // Admin approval/disable/remap is applied before any physical dispatch.
    socket.on('printer_device_registry_request', async (payload = {}) => {
      await handlePrinterDeviceRegistryRequest({
        socket,
        prisma,
        logger,
        requestId: payload?.requestId
      });
    });

    // Final database authorization runs after Agent document preparation and
    // immediately before the device-bound Windows driver submission.
    socket.on('printer_device_dispatch_authorization_request', async (payload = {}) => {
      await authorizePrinterDeviceDispatch({ socket, prisma, request: payload });
    });

    socket.on('printer_device_dispatch_lease_renewal', async (payload = {}) => {
      const result = await renewPrinterDeviceDispatchLease({ socket, prisma, request: payload });
      socket.emit('printer_device_dispatch_lease_renewal_result', {
        requestId: payload?.requestId,
        jobId: payload?.jobId,
        printerDeviceId: payload?.printerDeviceId,
        windowsPrinterName: payload?.windowsPrinterName,
        renewed: result.renewed,
        leaseId: result.leaseId || null,
        expiresAt: result.expiresAt ? result.expiresAt.toISOString() : null,
        code: result.code || null
      });
      if (!result.renewed) {
        logger.warn(`Printer dispatch lease renewal refused for request ${payload?.requestId || 'unknown'}: ${result.code || 'unknown error'}`);
      }
    });

    socket.on('printer_device_dispatch_lease_release', async (payload = {}) => {
      const result = await releasePrinterDeviceDispatchLease({ socket, prisma, request: payload });
      if (!result.released && result.code !== 'DISPATCH_LEASE_NOT_ACTIVE') {
        logger.warn(`Printer dispatch lease release failed for request ${payload?.requestId || 'unknown'}: ${result.code || 'unknown error'}`);
      }
    });

    // Discovery is persisted for Admin review only; it never approves a device.
    socket.on('printer_inventory_report', async (payload) => {
      await handlePrinterInventoryReport({ socket, io, logger, prisma, payload });
    });

    // Kiosk <-> Mobile Sync
    socket.on('join_session', (sessionId) => {
      // Validate: session tokens can only join their own session room
      if (socket.userType === 'session' && socket.sessionId && socket.sessionId !== sessionId) {
        logger.warn(`Socket ${socket.id} tried to join session ${sessionId} but owns ${socket.sessionId}`);
        return;
      }
      socket.join(sessionId);
      logger.info(`Socket ${socket.id} joined session ${sessionId}`);
    });

    // Helper: validate that the emitting socket owns the target session
    const validateSessionOwnership = (socket, targetSessionId) => {
      if (socket.userType !== 'session') return false;
      if (!socket.sessionId || socket.sessionId !== targetSessionId) {
        logger.warn(`Socket ${socket.id} tried to emit to session ${targetSessionId} but owns ${socket.sessionId}`);
        return false;
      }
      return true;
    };

    socket.on('mobile_connected', (sessionId) => {
      if (!validateSessionOwnership(socket, sessionId)) return;
      io.to(sessionId).emit('kiosk_user_connected');
    });

    socket.on('file_uploaded', ({ sessionId, fileData }) => {
      if (!validateSessionOwnership(socket, sessionId)) return;
      io.to(sessionId).emit('kiosk_file_uploaded', fileData);
    });

    socket.on('settings_updated', ({ sessionId, settingsData, price }) => {
      if (!validateSessionOwnership(socket, sessionId)) return;
      io.to(sessionId).emit('kiosk_settings_updated', { settingsData, price });
    });

    socket.on('track_job', (jobId) => {
      if (jobId && typeof jobId === 'string') {
        socket.join(`job_${jobId}`);
      }
    });

    socket.on('payment_initiated', ({ sessionId, price, jobId }) => {
      if (!validateSessionOwnership(socket, sessionId)) return;
      if (jobId) socket.join(`job_${jobId}`);
      io.to(sessionId).emit('kiosk_payment_initiated', { price, jobId });
    });

    socket.on('payment_success', ({ sessionId, jobId }) => {
      if (!validateSessionOwnership(socket, sessionId)) return;
      io.to(sessionId).emit('kiosk_payment_success', { jobId });
      if (jobId) {
        io.to(`job_${jobId}`).emit('kiosk_payment_success', { jobId });
      }
    });

    socket.on('cancel_session', ({ sessionId }) => {
      if (!validateSessionOwnership(socket, sessionId)) return;
      io.to(sessionId).emit('session_cancelled');
    });

    socket.on('heartbeat', async () => {
      if (socket.machineId) {
        try {
          await prisma.machine.update({
            where: { id: socket.machineId },
            data: { lastOnline: new Date() }
          });
        } catch (err) {
          logger.error(`Error updating heartbeat for machine ${socket.machineId}:`, err);
        }
      }
    });

    socket.on('printer_status_update', async (status) => {
      // Keep child-printer health separate from the legacy Machine-wide
      // PrinterStatus stream until device-bound QR/session routing ships.
      if (status?.printerDeviceId) {
        await handlePrinterDeviceTelemetry({ socket, io, prisma, logger, status });
        return;
      }

      if (socket.machineId) {
        try {
          const printerModel = (status?.printerModel || status?.printerName || status?.model || '').trim();
          const connectionType = (status?.connectionType || status?.telemetry?.connectionType || '').trim();

          const machineUpdateData = { lastOnline: new Date() };
          if (printerModel) {
            machineUpdateData.printerModel = printerModel;
          }
          if (connectionType) {
            machineUpdateData.connectionType = connectionType;
          }

          await prisma.machine.update({
            where: { id: socket.machineId },
            data: machineUpdateData
          });

          await prisma.printerStatus.create({
            data: {
              machineId: socket.machineId,
              isOnline: !status.isError,
              paperStatus: status.errorMessage === 'Out of Paper' ? 'OUT' : 'OK',
              jamStatus: status.errorMessage === 'Paper Jam',
              connectionType: connectionType || undefined
            }
          });

          const availability = await getMachineAvailability(socket.machineId, prisma);
          const broadcastPayload = {
            ...status,
            ...(availability || {}),
            printerModel: printerModel || availability?.printerModel || 'Unknown',
            connectionType: connectionType || availability?.connectionType || 'Unknown',
            machineId: socket.machineId,
          };

          if (availability) {
            // Broadcast authoritative availability to customer sessions AND tenant/superadmin sockets
            io.to(`machine_${socket.machineId}`).emit('printer_status_update', broadcastPayload);
          }
          if (socket.companyId) {
            io.to(`company_${socket.companyId}`).emit('printer_status_update', broadcastPayload);
          }
          io.to('superadmins').emit('printer_status_update', broadcastPayload);
        } catch(err) {
          logger.error('Error saving printer status', err);
        }
      } else {
        if (socket.companyId) {
          io.to(`company_${socket.companyId}`).emit('printer_status_update', status);
        }
        io.to('superadmins').emit('printer_status_update', status);
      }
    });

    socket.on('job_reconciliation_report', async (report) => {
      const { requestId, jobId, status } = report || {};
      // 1. Verify authenticated Agent identity and printer type
      if (socket.userType !== 'printer' || !socket.machineId) {
        logger.warn(`Unauthorized or non-printer socket attempted reconciliation report`);
        return;
      }

      logger.info(`Agent on machine ${socket.machineId} reported reconciliation for job ${jobId}: ${status} [ReqID: ${requestId || 'none'}]`);

      // 2. Correlation verification: verify report matches active reconciliation request
      let active = null;
      if (socket.pendingReconciliations && requestId && socket.pendingReconciliations.has(requestId)) {
        active = socket.pendingReconciliations.get(requestId);
      } else if (requestId && pendingReconciliationsByRequestId.has(requestId)) {
        active = pendingReconciliationsByRequestId.get(requestId);
      } else if (socket.activeReconciliation && (!requestId || socket.activeReconciliation.requestId === requestId)) {
        active = socket.activeReconciliation;
      }

      if (!active) {
        logger.warn(`Rejected reconciliation report for job ${jobId}: No active reconciliation request matching ReqID ${requestId || 'none'}`);
        return;
      }

      // Check machine ownership on the request
      if (active.machineId && active.machineId !== socket.machineId) {
        logger.warn(`Rejected cross-machine reconciliation report for job ${jobId}: Request belongs to machine ${active.machineId}, but reported by ${socket.machineId}`);
        return;
      }

      // Check request ID matching and timeout (60 seconds)
      const isExpired = (Date.now() - active.createdAt) > RECONCILIATION_EXPIRY_MS;
      if (isExpired || active.requestId !== requestId || !active.jobIds || !active.jobIds.has(jobId)) {
        if (isExpired && requestId) {
          if (socket.pendingReconciliations) socket.pendingReconciliations.delete(requestId);
          pendingReconciliationsByRequestId.delete(requestId);
        }
        logger.warn(`Rejected stale/uncorrelated reconciliation report for job ${jobId} (ReqID match: ${active.requestId === requestId}, Expired: ${isExpired})`);
        return;
      }

      // Immediately consume the jobId from the active set to prevent concurrent duplicate processing
      active.jobIds.delete(jobId);

      // Do not consume the one-shot reconciliation slot until the authenticated
      // Agent has proven the exact DB job/device binding and Machine ownership.
      let reportIdentityValidated = false;
      let transitionSuccess = false;
      try {
        await prisma.$transaction(async (tx) => {
          const job = await tx.printJob.findUnique({
            where: { shortId: jobId },
            include: { payment: true, printerDevice: true }
          });

          if (!job) {
            logger.warn(`Reconciliation failed: Job ${jobId} not found`);
            return;
          }

          // Device-bound and legacy jobs must report the exact expected printer identity.
          if (!verifyPrinterDeviceReport(job, report)) {
            logger.warn(`Reconciliation rejected: PrinterDevice identity mismatch for job ${jobId}`);
            return;
          }

          // Verify exact Machine ownership before consuming the correlated request.
          if (job.machineId !== socket.machineId) {
            logger.warn(`Reconciliation security rejection: Job ${jobId} belongs to machine ${job.machineId}, but reported by ${socket.machineId}`);
            return;
          }
          reportIdentityValidated = true;

          if (status === 'COMPLETED_LOCALLY') {
            // Physical completion clearance strictly requires the job to have been dispatched and in PRINTING state.
            // WAITING jobs were never claimed or dispatched to the physical printer and cannot transition directly to COMPLETED (violates state machine).
            if (job.status !== 'PRINTING') {
              logger.warn(`Reconciliation rejected: Job ${jobId} status is ${job.status}, expected PRINTING for COMPLETED_LOCALLY`);
              reportIdentityValidated = false;
              return;
            }

            // Verify payment was successfully confirmed
            if (!job.payment || job.payment.status !== 'SUCCESS') {
              logger.warn(`Reconciliation rejected: Job ${jobId} payment is not SUCCESS (payment status: ${job.payment?.status})`);
              reportIdentityValidated = false;
              return;
            }

            if (!active.validatedCompletions) {
              active.validatedCompletions = new Map();
            }
            active.validatedCompletions.set(jobId, {
              jobId,
              machineId: socket.machineId,
              printerDeviceId: job.printerDeviceId,
              validatedAt: Date.now()
            });
            logger.info(`Job ${jobId} validated as COMPLETED_LOCALLY under request ${requestId}. Awaiting spooler clearance.`);
            return;
          }

          // Valid non-NOT_DISPATCHED reports consume the slot but never trigger a reprint.
          if (status !== 'NOT_DISPATCHED') return;

          // Must be currently in PRINTING status
          if (job.status !== 'PRINTING') {
            logger.warn(`Reconciliation skipped: Job ${jobId} status is ${job.status}, expected PRINTING`);
            return;
          }

          // 4. Verify payment was successfully confirmed
          if (!job.payment || job.payment.status !== 'SUCCESS') {
            logger.warn(`Reconciliation rejected: Job ${jobId} payment is not SUCCESS (payment status: ${job.payment?.status})`);
            return;
          }

          // 5. Atomic conditional update: PRINTING -> WAITING
          const resetCount = await tx.printJob.updateMany({
            where: {
              id: job.id,
              shortId: jobId,
              machineId: socket.machineId,
              status: 'PRINTING'
            },
            data: { status: 'WAITING' }
          });

          if (resetCount.count === 1) {
            transitionSuccess = true;
            logger.info(`Job ${jobId} safely restored from PRINTING to WAITING for re-dispatch after verified NOT_DISPATCHED report`);
          }
        }, { maxWait: 5000, timeout: 10000 });
      } catch (txErr) {
        logger.error(`Transaction error during reconciliation reset for job ${jobId}:`, txErr);
        return;
      }

      if (!reportIdentityValidated) {
        // Leave the request slot available so a valid report can still reconcile it.
        active.jobIds.add(jobId);
        return;
      }

      // If all jobs in this request are now resolved/consumed, clean up the correlation entry
      const hasPendingJobIds = active.jobIds && active.jobIds.size > 0;
      const hasValidated = active.validatedCompletions && active.validatedCompletions.size > 0;
      if (!hasPendingJobIds && !hasValidated && requestId) {
        if (socket.pendingReconciliations) socket.pendingReconciliations.delete(requestId);
        pendingReconciliationsByRequestId.delete(requestId);
      }

      // Never automatically reset jobs when Agent reports anything other than NOT_DISPATCHED.
      if (status !== 'NOT_DISPATCHED') {
        logger.info(`Job ${jobId} reported status "${status}". Not eligible for automatic NOT_DISPATCHED re-dispatch.`);
        return;
      }

      // 6 & 7. Invoke queueService.startPrintingProcess() reusing the WAITING -> PRINTING atomic claim
      if (transitionSuccess) {
        const queueService = require('./services/queueService');
        if (queueService && typeof queueService.startPrintingProcess === 'function') {
          logger.info(`Re-dispatching recovered job ${jobId} to printer agent`);
          await queueService.startPrintingProcess(jobId, io);
        }
      }
    });

    socket.on('print_spooler_success', async (report) => {
      if (socket.userType !== 'printer' || !socket.machineId) return;
      const jobId = report?.jobId;
      try {
        const currentJob = await prisma.printJob.findUnique({
          where: { shortId: jobId },
          include: { printerDevice: true }
        });
        if (!currentJob || currentJob.machineId !== socket.machineId) return;
        if (!verifyPrinterDeviceReport(currentJob, report)) return;
        logger.info(`Print spooler accepted job ${jobId}. Awaiting physical completion...`);
      } catch (error) {
        logger.error(`Failed to verify spooler acceptance for job ${jobId}:`, error);
      }
    });

    const handleSpoolerClearance = async (payload, eventName = 'print_spooler_cleared') => {
      if (socket.userType !== 'printer' || !socket.machineId) return;
      const jobId = typeof payload === 'object' ? payload?.jobId : payload;
      logger.info(`Spooler clearance (${eventName}) reported for job ${jobId} by machine ${socket.machineId}`);
      try {
        const normalizedReport = typeof payload === 'object' && payload !== null ? payload : { jobId };
        const currentJob = await prisma.printJob.findUnique({
          where: { shortId: jobId },
          include: { document: true, printerDevice: true, machine: true }
        });
        if (!currentJob) return;

        // Device-bound and legacy jobs must report the exact expected printer identity.
        if (!verifyPrinterDeviceReport(currentJob, normalizedReport)) {
          logger.warn(`Spooler clearance rejected: PrinterDevice identity mismatch for job ${jobId}`);
          socket.emit('print_physical_ambiguous', {
            jobId,
            requestId: normalizedReport?.requestId,
            reason: 'Spooler clearance rejected: PrinterDevice identity mismatch',
            wasSeenInQueue: normalizedReport?.wasSeenInQueue === true
          });
          return;
        }

        // P0: Enforce Machine Ownership
        if (currentJob.machineId !== socket.machineId) {
          logger.warn(`Machine ${socket.machineId} attempted to mark job ${jobId} as COMPLETED, but job belongs to ${currentJob.machineId}`);
          socket.emit('print_physical_ambiguous', {
            jobId,
            requestId: normalizedReport?.requestId,
            reason: 'Spooler clearance rejected: Machine ownership mismatch',
            wasSeenInQueue: normalizedReport?.wasSeenInQueue === true
          });
          return;
        }

        // V6 Architecture Contract: A spooler queue that was never observed must never be treated as successfully cleared
        const wasSeenInQueue = normalizedReport.wasSeenInQueue === true;
        const isReconciled = normalizedReport.reconciled === true || Boolean(normalizedReport.requestId);
        const isSimulation = normalizedReport.mode === 'simulation';

        // Simulation mode security check: must be explicitly allowed by backend environment policy
        if (isSimulation && !isSimulationAllowed()) {
          logger.warn(`Spooler clearance refused for job ${jobId}: Simulation mode is not permitted by backend policy in current environment.`);
          socket.emit('print_physical_ambiguous', {
            jobId,
            reason: 'Spooler clearance rejected: Simulation mode not permitted in current environment.',
            wasSeenInQueue: false
          });
          return;
        }

        // Reconciliation completion correlation: must strictly correlate to active server-side request
        let activeCorrelation = null;
        if (isReconciled) {
          const reqId = normalizedReport.requestId;
          if (!reqId || typeof reqId !== 'string') {
            logger.warn(`Spooler clearance refused for job ${jobId}: Missing or invalid requestId for reconciled completion.`);
            socket.emit('print_physical_ambiguous', {
              jobId,
              reason: 'Spooler clearance rejected: Missing requestId for reconciliation.',
              wasSeenInQueue
            });
            return;
          }

          if (socket.pendingReconciliations && socket.pendingReconciliations.has(reqId)) {
            activeCorrelation = socket.pendingReconciliations.get(reqId);
          } else if (pendingReconciliationsByRequestId.has(reqId)) {
            activeCorrelation = pendingReconciliationsByRequestId.get(reqId);
          } else if (socket.activeReconciliation && socket.activeReconciliation.requestId === reqId) {
            activeCorrelation = socket.activeReconciliation;
          }

          if (!activeCorrelation) {
            logger.warn(`Spooler clearance refused for job ${jobId}: No active reconciliation request found for reqId ${reqId}.`);
            socket.emit('print_physical_ambiguous', {
              jobId,
              requestId: reqId,
              reason: 'Spooler clearance rejected: No matching active reconciliation request.',
              wasSeenInQueue
            });
            return;
          }

          if (activeCorrelation.machineId && activeCorrelation.machineId !== socket.machineId) {
            logger.warn(`Spooler clearance refused for job ${jobId}: Request ${reqId} belongs to machine ${activeCorrelation.machineId}, reported by ${socket.machineId}.`);
            socket.emit('print_physical_ambiguous', {
              jobId,
              requestId: reqId,
              reason: 'Spooler clearance rejected: Machine mismatch on reconciliation request.',
              wasSeenInQueue
            });
            return;
          }

          const isExpired = (Date.now() - activeCorrelation.createdAt) > RECONCILIATION_EXPIRY_MS;
          if (isExpired) {
            logger.warn(`Spooler clearance refused for job ${jobId}: Reconciliation request ${reqId} has expired.`);
            if (socket.pendingReconciliations) socket.pendingReconciliations.delete(reqId);
            pendingReconciliationsByRequestId.delete(reqId);
            socket.emit('print_physical_ambiguous', {
              jobId,
              requestId: reqId,
              reason: 'Spooler clearance rejected: Reconciliation request expired.',
              wasSeenInQueue
            });
            return;
          }

          // Check for replay of already consumed job
          if (activeCorrelation.consumedJobs && activeCorrelation.consumedJobs.has(jobId)) {
            logger.warn(`Spooler clearance refused for job ${jobId}: Replayed completion report for requestId ${reqId}.`);
            socket.emit('print_physical_ambiguous', {
              jobId,
              requestId: reqId,
              reason: 'Spooler clearance rejected: Replayed completion report.',
              wasSeenInQueue
            });
            return;
          }

          // Must be present in either jobIds or validatedCompletions
          const inJobIds = activeCorrelation.jobIds && activeCorrelation.jobIds.has(jobId);
          const isValidatedLocally = activeCorrelation.validatedCompletions && activeCorrelation.validatedCompletions.has(jobId);

          if (!inJobIds && !isValidatedLocally) {
            logger.warn(`Spooler clearance refused for job ${jobId}: Job not included in reconciliation request ${reqId}.`);
            socket.emit('print_physical_ambiguous', {
              jobId,
              requestId: reqId,
              reason: 'Spooler clearance rejected: Job not in reconciliation request.',
              wasSeenInQueue
            });
            return;
          }

          // Check multi-printer binding if recorded in request
          if (activeCorrelation.jobBindings && activeCorrelation.jobBindings[jobId]) {
            const expectedBinding = activeCorrelation.jobBindings[jobId];
            const reportedDeviceId = normalizedReport.printerDeviceId;
            if (expectedBinding.printerDeviceId && reportedDeviceId && reportedDeviceId !== expectedBinding.printerDeviceId) {
              logger.warn(`Spooler clearance refused for job ${jobId}: Reported device ${reportedDeviceId} does not match expected binding ${expectedBinding.printerDeviceId}.`);
              socket.emit('print_physical_ambiguous', {
                jobId,
                requestId: reqId,
                reason: 'Spooler clearance rejected: PrinterDevice binding mismatch.',
                wasSeenInQueue
              });
              return;
            }
          }
        }

        if (!wasSeenInQueue && !isReconciled && !isSimulation) {
          logger.warn(`Spooler clearance refused for job ${jobId}: Queue was never observed by spooler monitor.`);
          socket.emit('print_physical_ambiguous', {
            jobId,
            reason: 'Spooler clearance rejected: Queue was never observed in Windows spooler.',
            wasSeenInQueue: false
          });
          return;
        }

        // Idempotency: If already COMPLETED, acknowledge to agent and do nothing further (no duplicate history)
        if (currentJob.status === 'COMPLETED') {
          socket.emit('ack_job_completed', { jobId });
          return;
        }

        if (!isValidJobTransition(currentJob.status, 'COMPLETED')) {
          logger.warn(`Ignoring invalid transition from ${currentJob.status} to COMPLETED for job ${jobId}`);
          return;
        }

        const completedJob = await prisma.printJob.update({
          where: { shortId: jobId },
          data: { status: 'COMPLETED' },
          include: { document: true, machine: true }
        });

        // Store truthful evidence text in PrintHistory (never claiming sensor-verified paper ejection)
        const evidenceDetails = isReconciled
          ? 'Reconciled via agent journal evidence: Windows spooler transmission confirmed'
          : (isSimulation
            ? 'Simulation mode: spooler clearance simulated'
            : 'Windows spooler transmission and queue clearance confirmed (sensor-verified physical paper ejection unverified)');

        await prisma.printHistory.create({
          data: {
            printJobId: currentJob.id,
            success: true,
            errorDetails: evidenceDetails,
            completedAt: new Date()
          }
        }, { maxWait: 5000, timeout: 10000 });

        // Clean up correlation request entry and mark as consumed
        if (isReconciled && activeCorrelation) {
          if (!activeCorrelation.consumedJobs) {
            activeCorrelation.consumedJobs = new Set();
          }
          activeCorrelation.consumedJobs.add(jobId);
          if (activeCorrelation.validatedCompletions) {
            activeCorrelation.validatedCompletions.delete(jobId);
          }
          if (activeCorrelation.jobIds) {
            activeCorrelation.jobIds.delete(jobId);
          }
          const hasRemainingJobIds = activeCorrelation.jobIds && activeCorrelation.jobIds.size > 0;
          const hasRemainingValidated = activeCorrelation.validatedCompletions && activeCorrelation.validatedCompletions.size > 0;
          if (!hasRemainingJobIds && !hasRemainingValidated) {
            const reqId = normalizedReport.requestId;
            if (socket.pendingReconciliations) socket.pendingReconciliations.delete(reqId);
            pendingReconciliationsByRequestId.delete(reqId);
          }
        }

        // Acknowledge receipt to the agent
        socket.emit('ack_job_completed', { jobId });
        logger.info(`Job ${jobId} marked COMPLETED (spooler cleared) and acknowledged to machine ${socket.machineId}`);

        // Notify client and admin rooms
        const statusEvent = {
          id: completedJob.id,
          shortId: completedJob.shortId,
          status: 'COMPLETED',
          message: 'Spooler transmission and queue clearance confirmed.'
        };
        io.to(`job_${jobId}`).emit('job_status_changed', statusEvent);
        if (completedJob.machineId) io.to(`machine_${completedJob.machineId}`).emit('job_status_changed', statusEvent);
        if (completedJob.machine?.companyId) io.to(`company_${completedJob.machine.companyId}`).emit('job_status_changed', statusEvent);
        io.to('superadmins').emit('job_status_changed', statusEvent);
        io.to('admins').emit('job_status_changed', statusEvent);
      } catch (err) {
        logger.error(`Failed to update job ${jobId} to COMPLETED on spooler clearance:`, err);
      }
    };

    // V6 Architecture Contract: print_spooler_cleared is the authoritative event
    socket.on('print_spooler_cleared', async (payload) => {
      await handleSpoolerClearance(payload, 'print_spooler_cleared');
    });

    // Backward-compatible alias: subject to identical ownership, evidence, and ambiguity checks
    socket.on('print_physical_success', async (payload) => {
      await handleSpoolerClearance(payload, 'print_physical_success');
    });

    socket.on('print_physical_ambiguous', async (report) => {
      if (socket.userType !== 'printer' || !socket.machineId) return;
      const { jobId, reason, wasSeenInQueue } = report || {};
      logger.warn(`Job ${jobId} physical outcome ambiguous: ${reason}. Keeping status as PRINTING for operator reconciliation.`);
      try {
        const currentJob = await prisma.printJob.findUnique({
          where: { shortId: jobId },
          include: { printerDevice: true }
        });
        if (currentJob && !verifyPrinterDeviceReport(currentJob, report)) return;
        if (currentJob) {
          // Machine ownership guard
          if (currentJob.machineId !== socket.machineId) {
            logger.warn(`Machine ${socket.machineId} attempted to report ambiguous outcome for job ${jobId} belonging to ${currentJob.machineId}`);
            return;
          }
          await prisma.printHistory.create({
            data: {
              printJobId: currentJob.id,
              success: false,
              errorDetails: `Ambiguous outcome: ${reason} (wasSeenInQueue: ${wasSeenInQueue})`,
              completedAt: new Date()
            }
          });

          if (prisma.reconciliationRecord) {
            await prisma.reconciliationRecord.create({
              data: {
                printJobId: currentJob.id,
                paymentId: currentJob.paymentId || null,
                status: 'MANUAL_REVIEW_REQUIRED',
                discrepancyType: 'AMBIGUOUS_PHYSICAL_PRINT_OUTCOME',
                details: JSON.stringify({
                  shortId: jobId,
                  machineId: socket.machineId,
                  reason,
                  wasSeenInQueue
                })
              }
            }).catch(() => {});
          }
        }
      } catch (e) {
        logger.error('Error logging ambiguous print outcome:', e);
      }
    });

    socket.on('print_physical_error', async (report) => {
      if (socket.userType !== 'printer' || !socket.machineId) return;
      const { jobId, error } = report || {};
      logger.error(`Physical print error reported for job ${jobId}: ${error}`);
      try {
        const currentJob = await prisma.printJob.findUnique({
          where: { shortId: jobId },
          include: { printerDevice: true, payment: true }
        });
        if (!currentJob) return;
        if (!verifyPrinterDeviceReport(currentJob, report)) return;

        // P0: Enforce Machine Ownership
        if (currentJob.machineId !== socket.machineId) {
          logger.warn(`Machine ${socket.machineId} attempted to report physical error for job ${jobId}, but job belongs to ${currentJob.machineId}`);
          return;
        }

        // UP-03 & UP-06 Safety Rule: Once durable DISPATCH_INTENT exists (job is PRINTING),
        // uncertain physical outcome must NEVER automatically become FAILED or trigger automatic refund.
        // A paper jam or spooler glitch after dispatch means partial pages may have printed.
        // Report such cases as ambiguous, retain PRINTING, and require authorized operator resolution.
        if (currentJob.status === 'PRINTING') {
          logger.warn(`Job ${jobId} reported physical error after handoff: ${error}. Retaining PRINTING status (ambiguity lock). Automatic refund suppressed.`);
          
          await prisma.printHistory.create({
            data: {
              printJobId: currentJob.id,
              success: false,
              errorDetails: `Ambiguous physical error after spooler handoff: ${error || 'Unknown error'}. Job retained in PRINTING for authorized operator inspection.`,
              completedAt: new Date()
            }
          }).catch(() => {});

          if (prisma.reconciliationRecord) {
            await prisma.reconciliationRecord.create({
              data: {
                printJobId: currentJob.id,
                paymentId: currentJob.paymentId || null,
                status: 'MANUAL_REVIEW_REQUIRED',
                discrepancyType: 'POST_HANDOFF_PHYSICAL_ERROR',
                details: JSON.stringify({
                  shortId: jobId,
                  machineId: socket.machineId,
                  error: error || 'Physical error after handoff',
                  reason: 'Error occurred after job entered print spooler. Partial output may have been produced. Automatic refund withheld under fail-closed policy.'
                })
              }
            }).catch(() => {});
          }

          io.to('superadmins').emit('job_status_changed', {
            id: currentJob.id,
            shortId: currentJob.shortId,
            status: 'PRINTING',
            ambiguous: true,
            error: `Physical print error reported: ${error}. Job retained in PRINTING for operator verification.`
          });
          io.to('admins').emit('job_status_changed', {
            id: currentJob.id,
            shortId: currentJob.shortId,
            status: 'PRINTING',
            ambiguous: true,
            error: `Physical print error reported: ${error}. Job retained in PRINTING for operator verification.`
          });
          return;
        }

        if (!isValidJobTransition(currentJob.status, 'FAILED')) return;

        const failedJob = await prisma.printJob.update({
          where: { shortId: jobId },
          data: { status: 'FAILED' },
          include: { document: true, payment: true }
        });

        // Pre-dispatch verified failures only: refund only if payment succeeded
        if (failedJob.paymentId && failedJob.payment?.status === 'SUCCESS') {
          logger.info(`Initiating automated refund for pre-dispatch FAILED job ${jobId}...`);
          const paymentsService = require('./modules/payments/payments.service');
          await paymentsService.refundPayment(failedJob.shortId).catch((refErr) => {
            logger.error(`Automated refund failed for job ${jobId}:`, refErr.message);
          });
        }
      } catch (err) {
        logger.error(`Failed to process physical error for job ${jobId}:`, err);
      }
    });

    socket.on('print_spooler_error', async (report) => {
      if (socket.userType !== 'printer' || !socket.machineId) {
        logger.warn(`Non-printer socket ${socket.id} tried to report spooler error`);
        return;
      }
      const { jobId, error } = report || {};
      logger.error(`Print spooler failed for job ${jobId}: ${error}`);
      try {
        // Validate state transition before updating
        const currentJob = await prisma.printJob.findUnique({
          where: { shortId: jobId },
          include: { printerDevice: true }
        });
        if (currentJob && !verifyPrinterDeviceReport(currentJob, report)) return;
        if (!currentJob || !isValidJobTransition(currentJob.status, 'FAILED')) {
          logger.warn(`Ignoring spooler error for job ${jobId}: invalid transition from ${currentJob?.status}`);
          return;
        }

        // P0: Enforce Machine Ownership
        if (currentJob.machineId !== socket.machineId) {
          logger.warn(`Machine ${socket.machineId} attempted to mark job ${jobId} spooler error, but job belongs to ${currentJob.machineId}`);
          return;
        }

        const failedJob = await prisma.printJob.update({
          where: { shortId: jobId },
          data: { status: 'FAILED' },
          include: { document: true, payment: true }
        });

        // This event is used for Agent failures before durable driver intent,
        // including a final backend authorization denial. Refund only payments
        // that have already reached SUCCESS and use a stable idempotency key.
        if (failedJob.paymentId && failedJob.payment?.status === 'SUCCESS') {
          try {
            const paymentsService = require('./modules/payments/payments.service');
            await paymentsService.refundPayment(
              failedJob.shortId,
              null,
              `Automatic refund: Printer Agent could not submit the document. ${error || 'Unknown spooler error'}`,
              {
                initiatedBy: 'SYSTEM',
                preserveJobStatus: true,
                idempotencyKey: `agent_spooler_failure_${failedJob.id}_${failedJob.paymentId}`
              }
            );
          } catch (refundError) {
            logger.error(`Automatic refund failed for spooler error on job ${jobId}:`, refundError);
          }
        }
      } catch (err) {
        logger.error(`Failed to update job ${jobId} to FAILED:`, err);
        io.to(`machine_${socket.machineId}`).emit('job_status_changed', { id: 'error', shortId: jobId, status: 'FAILED', error });
      }
    });

    socket.on('disconnect', async () => {
      logger.info(`User disconnected: ${socket.id} (Type: ${socket.userType})`);
      if (socket.userType === 'printer' && socket.machineId) {
        // Clean up socket from active printer sockets and invalidate pending requests
        const set = authenticatedPrinterSockets.get(socket.machineId);
        if (set) {
          set.delete(socket);
          if (set.size === 0) {
            authenticatedPrinterSockets.delete(socket.machineId);
          }
        }
        if (socket.pendingReconciliations) {
          socket.pendingReconciliations.clear();
        }
        socket.activeReconciliation = null;

        try {
          const machine = await prisma.machine.findUnique({ where: { id: socket.machineId } });
          if (machine) {
            const offlineState = computePrinterAvailability({ ...machine, lastOnline: null }, null);
            const payload = {
              machineId: socket.machineId,
              name: machine.name,
              location: machine.location,
              printerModel: machine.printerModel || 'EPSON L6460 Series',
              ...offlineState
            };
            io.to(`machine_${socket.machineId}`).emit('printer_status_update', payload);
            if (machine.companyId) {
              io.to(`company_${machine.companyId}`).emit('printer_status_update', payload);
            }
            io.to('superadmins').emit('printer_status_update', payload);
          }
        } catch (err) {
          logger.error('Error broadcasting printer disconnect:', err);
        }
      }
    });
  });
};

setupSockets.setupSockets = setupSockets;
setupSockets.requestPrinterReconciliation = requestPrinterReconciliation;
setupSockets.registerReconciliationOnSocket = registerReconciliationOnSocket;
setupSockets.clearAllReconciliationState = clearAllReconciliationState;

module.exports = setupSockets;
