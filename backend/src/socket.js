const prisma = require('./utils/prisma');
const logger = require('./utils/logger');
const { isValidJobTransition } = require('./utils/stateMachine');
const { computeIsOnline } = require('./modules/machines/machines.service');
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
            socket.activeReconciliation = {
              requestId,
              jobIds: new Set(jobIds),
              jobBindings,
              createdAt: Date.now()
            };
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
          const now = new Date();
          const machine = await prisma.machine.update({
            where: { id: socket.machineId },
            data: { lastOnline: now }
          });
          const isOnline = computeIsOnline(machine, now);
          io.to('admins').emit('printer_heartbeat', {
            machineId: socket.machineId,
            lastOnline: machine.lastOnline,
            isOnline
          });
        } catch (err) {
          logger.error(`Error updating heartbeat for machine ${socket.machineId}:`, err);
        }
      }
    });

    socket.on('printer_status_update', async (status) => {
      // Child-printer telemetry: process through device telemetry bridge.
      // If the emitting device is the verified sole active default printer,
      // it bridges to machine-level availability and broadcasts to customer/admin rooms.
      if (status?.printerDeviceId) {
        try {
          const result = await handlePrinterDeviceTelemetry({ socket, io, prisma, logger, status });
          if (result?.bridged === true && socket.machineId) {
            const availability = await getMachineAvailability(socket.machineId, prisma);
            const broadcastPayload = {
              ...status,
              ...(availability || {}),
              printerModel: availability?.printerModel || 'Unknown',
              connectionType: (status?.connectionType || availability?.connectionType || 'Unknown'),
              machineId: socket.machineId,
            };

            if (availability) {
              io.to(`machine_${socket.machineId}`).emit('printer_status_update', broadcastPayload);
            }
            if (socket.companyId) {
              io.to(`company_${socket.companyId}`).emit('printer_status_update', broadcastPayload);
            }
            io.to('superadmins').emit('printer_status_update', broadcastPayload);
          }
        } catch (err) {
          logger.error('Error handling printer device telemetry bridge:', err);
        }
        return;
      }

      if (socket.machineId) {
        try {
          const printerModel = (status?.printerModel || status?.printerName || status?.model || '').trim();
          const connectionType = (status?.connectionType || status?.telemetry?.connectionType || '').trim();

          const now = new Date();
          const machineUpdateData = { lastOnline: now };
          if (printerModel) {
            machineUpdateData.printerModel = printerModel;
          }
          if (connectionType) {
            machineUpdateData.connectionType = connectionType;
          }

          const machine = await prisma.machine.update({
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

          const isOnline = computeIsOnline(machine, now);
          io.to('admins').emit('printer_heartbeat', {
            machineId: socket.machineId,
            lastOnline: machine.lastOnline,
            isOnline
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
      const active = socket.activeReconciliation;
      if (!active) {
        logger.warn(`Rejected reconciliation report for job ${jobId}: No active reconciliation request on socket`);
        return;
      }

      // Check request ID matching and timeout (60 seconds)
      const isExpired = (Date.now() - active.createdAt) > 60000;
      if (isExpired || active.requestId !== requestId || !active.jobIds || !active.jobIds.has(jobId)) {
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

    socket.on('print_physical_success', async (payload) => {
      if (socket.userType !== 'printer') return;
      const jobId = typeof payload === 'object' ? payload.jobId : payload;
      logger.info(`Physical print success reported for job ${jobId}`);
      try {
        const normalizedReport = typeof payload === 'object' && payload !== null ? payload : { jobId };
        const currentJob = await prisma.printJob.findUnique({
          where: { shortId: jobId },
          include: { document: true, printerDevice: true }
        });
        if (!currentJob) return;

        if (!verifyPrinterDeviceReport(currentJob, normalizedReport)) return;

        // P0: Enforce Machine Ownership
        if (currentJob.machineId !== socket.machineId) {
          logger.warn(`Machine ${socket.machineId} attempted to mark job ${jobId} as COMPLETED, but job belongs to ${currentJob.machineId}`);
          return;
        }

        // Idempotency: If already COMPLETED, acknowledge to agent and do nothing further
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
          include: { document: true }
        });

        // Record verification in PrintHistory
        await prisma.printHistory.create({
          data: {
            printJobId: currentJob.id,
            success: true,
            errorDetails: payload?.reconciled 
              ? 'Reconciled via agent journal evidence' 
              : (payload?.wasSeenInQueue ? 'Verified via Windows spooler polling' : 'Verified via driver dispatch confirmation'),
            completedAt: new Date()
          }
        }, { maxWait: 5000, timeout: 10000 });

        // Acknowledge receipt to the agent
        socket.emit('ack_job_completed', { jobId });
        logger.info(`Job ${jobId} marked COMPLETED and acknowledged to machine ${socket.machineId}`);
      } catch (err) {
        logger.error(`Failed to update job ${jobId} to COMPLETED:`, err);
      }
    });

    socket.on('print_physical_ambiguous', async (report) => {
      if (socket.userType !== 'printer' || !socket.machineId) return;
      const { jobId, reason, wasSeenInQueue } = report || {};
      logger.warn(`Job ${jobId} physical outcome ambiguous: ${reason}. Keeping status as PRINTING for operator reconciliation.`);
      try {
        await prisma.$transaction(async (tx) => {
          const currentJob = await tx.printJob.findUnique({
            where: { shortId: jobId },
            include: { printerDevice: true }
          });
          if (!currentJob) return;
          if (!verifyPrinterDeviceReport(currentJob, report)) return;

          // P0: Enforce Machine Ownership
          if (currentJob.machineId && socket.machineId && currentJob.machineId !== socket.machineId) {
            logger.warn(`Machine ${socket.machineId} attempted to record ambiguous outcome for job ${jobId}, but job belongs to ${currentJob.machineId}`);
            return;
          }

          // Concurrency & Status Guard:
          // An ambiguous event must NEVER alter or record ambiguity on a terminal or non-PRINTING job.
          // If the job is already COMPLETED, FAILED, or CANCELLED, reject the ambiguity update.
          if (currentJob.status !== 'PRINTING') {
            logger.warn(`Ignoring print_physical_ambiguous for job ${jobId}: current status is ${currentJob.status} (expected PRINTING)`);
            return;
          }

          // Create audit record in PrintHistory
          await tx.printHistory.create({
            data: {
              printJobId: currentJob.id,
              success: false,
              errorDetails: `Ambiguous outcome: ${reason} (wasSeenInQueue: ${wasSeenInQueue})`,
              completedAt: new Date()
            }
          });

          // Touch updatedAt to reset any cleaner timer while keeping status strictly in PRINTING
          await tx.printJob.update({
            where: { id: currentJob.id },
            data: { updatedAt: new Date() }
          });
        });
      } catch (e) {
        logger.error('Error logging ambiguous print outcome:', e);
      }
    });

    socket.on('print_physical_error', async (report) => {
      if (socket.userType !== 'printer' || !socket.machineId) return;
      const { jobId, error } = report || {};
      logger.error(`Physical print error for job ${jobId}: ${error}`);
      try {
        const currentJob = await prisma.printJob.findUnique({
          where: { shortId: jobId },
          include: { printerDevice: true }
        });
        if (currentJob && !verifyPrinterDeviceReport(currentJob, report)) return;
        if (!currentJob || !isValidJobTransition(currentJob.status, 'FAILED')) return;

        // P0: Enforce Machine Ownership
        if (currentJob.machineId !== socket.machineId) {
          logger.warn(`Machine ${socket.machineId} attempted to mark job ${jobId} as FAILED, but job belongs to ${currentJob.machineId}`);
          return;
        }

        const failedJob = await prisma.printJob.update({
          where: { shortId: jobId },
          data: { status: 'FAILED' },
          include: { document: true, payment: true }
        });

        // P3-002: Automated Refund on Print Failure
        if (failedJob.paymentId) {
          logger.info(`Initiating automated refund for FAILED job ${jobId}...`);
          const paymentsService = require('./modules/payments/payments.service');
          await paymentsService.refundPayment(failedJob.shortId);
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
        try {
          const machine = await prisma.machine.findUnique({
            where: { id: socket.machineId }
          });
          if (machine) {
            const isOnline = computeIsOnline(machine);
            io.to('admins').emit('printer_disconnected', {
              machineId: socket.machineId,
              lastOnline: machine.lastOnline,
              isOnline
            });

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

module.exports = setupSockets;
