const prisma = require('./utils/prisma');
const logger = require('./utils/logger');
const { isValidJobTransition } = require('./utils/stateMachine');
const { getMachineAvailability, computePrinterAvailability } = require('./services/printerAvailability.service');

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const {
  handlePrinterAgentHello,
  handlePrinterInventoryReport,
  handlePrinterDeviceTelemetry
} = require('./services/printerAgentProtocol.service');

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
            io.to('admins').emit('printer_status_update', availability);
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
            select: { shortId: true }
          });
          
          if (stuckJobs.length > 0) {
            const jobIds = stuckJobs.map(j => j.shortId);
            const requestId = `rec_${socket.machineId}_${Date.now()}_${crypto.randomUUID()}`;
            socket.activeReconciliation = {
              requestId,
              jobIds: new Set(jobIds),
              createdAt: Date.now()
            };
            logger.info(`Requesting reconciliation [ReqID: ${requestId}] for ${jobIds.length} active PRINTING job(s) from machine ${socket.machineId}: ${jobIds.join(', ')}`);
            socket.emit('reconcile_active_jobs', { requestId, jobIds });
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

    // Admin users join the 'admins' room for receiving printer status updates
    if (socket.userType === 'admin') {
      socket.join('admins');
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

    // Discovery is advisory only. This event never approves, binds, creates or
    // mutates PrinterDevice records; it is forwarded to Admin sockets for review.
    socket.on('printer_inventory_report', (payload) => {
      handlePrinterInventoryReport({ socket, io, logger, payload });
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
            // Broadcast authoritative availability to customer sessions AND admin sockets
            io.to(`machine_${socket.machineId}`).emit('printer_status_update', broadcastPayload);
            io.to('admins').emit('printer_status_update', broadcastPayload);
          } else {
            io.to('admins').emit('printer_status_update', broadcastPayload);
          }
        } catch(err) {
          logger.error('Error saving printer status', err);
        }
      } else {
        io.to('admins').emit('printer_status_update', status);
      }
    });

    socket.on('job_reconciliation_report', async ({ requestId, jobId, status }) => {
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

      // Consume this jobId from active request to prevent replay attacks
      active.jobIds.delete(jobId);

      // Never automatically reset jobs when Agent reports anything other than NOT_DISPATCHED
      if (status !== 'NOT_DISPATCHED') {
        logger.info(`Job ${jobId} reported status "${status}". Not eligible for automatic NOT_DISPATCHED re-dispatch.`);
        return;
      }

      // 3, 4, 5. Database-level verification & atomic transition from PRINTING -> WAITING
      let transitionSuccess = false;
      try {
        await prisma.$transaction(async (tx) => {
          const job = await tx.printJob.findUnique({
            where: { shortId: jobId },
            include: { payment: true }
          });

          if (!job) {
            logger.warn(`Reconciliation failed: Job ${jobId} not found`);
            return;
          }

          // 3. Verify exact machine ownership
          if (job.machineId !== socket.machineId) {
            logger.warn(`Reconciliation security rejection: Job ${jobId} belongs to machine ${job.machineId}, but reported by ${socket.machineId}`);
            return;
          }

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

      // 6 & 7. Invoke queueService.startPrintingProcess() reusing the WAITING -> PRINTING atomic claim
      if (transitionSuccess) {
        const queueService = require('./services/queueService');
        if (queueService && typeof queueService.startPrintingProcess === 'function') {
          logger.info(`Re-dispatching recovered job ${jobId} to printer agent`);
          await queueService.startPrintingProcess(jobId, io);
        }
      }
    });

    socket.on('print_spooler_success', async ({ jobId }) => {
      // Only printer agents should report spooler results
      if (socket.userType !== 'printer') return;
      logger.info(`Print spooler accepted job ${jobId}. Awaiting physical completion...`);
      // P3-001: We do NOT mark it COMPLETED here anymore. It stays PRINTING until physical success.
    });

    socket.on('print_physical_success', async (payload) => {
      if (socket.userType !== 'printer') return;
      const jobId = typeof payload === 'object' ? payload.jobId : payload;
      logger.info(`Physical print success reported for job ${jobId}`);
      try {
        const currentJob = await prisma.printJob.findUnique({ 
          where: { shortId: jobId }, 
          include: { document: true } 
        });
        if (!currentJob) return;

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

    socket.on('print_physical_ambiguous', async ({ jobId, reason, wasSeenInQueue }) => {
      if (socket.userType !== 'printer' || !socket.machineId) return;
      logger.warn(`Job ${jobId} physical outcome ambiguous: ${reason}. Keeping status as PRINTING for operator reconciliation.`);
      try {
        const currentJob = await prisma.printJob.findUnique({ where: { shortId: jobId } });
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
        }
      } catch (e) {
        logger.error('Error logging ambiguous print outcome:', e);
      }
    });

    socket.on('print_physical_error', async ({ jobId, error }) => {
      if (socket.userType !== 'printer') return;
      logger.error(`Physical print error for job ${jobId}: ${error}`);
      try {
        const currentJob = await prisma.printJob.findUnique({ where: { shortId: jobId } });
        if (!currentJob || !isValidJobTransition(currentJob.status, 'FAILED')) return;

        // P0: Enforce Machine Ownership
        if (currentJob.machineId !== socket.machineId) {
          logger.warn(`Machine ${socket.machineId} attempted to mark job ${jobId} as FAILED, but job belongs to ${currentJob.machineId}`);
          return;
        }

        const failedJob = await prisma.printJob.update({
          where: { shortId: jobId },
          data: { status: 'FAILED' },
          include: { document: true }
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

    socket.on('print_spooler_error', async ({ jobId, error }) => {
      if (socket.userType !== 'printer') {
        logger.warn(`Non-printer socket ${socket.id} tried to report spooler error`);
        return;
      }
      logger.error(`Print spooler failed for job ${jobId}: ${error}`);
      try {
        // Validate state transition before updating
        const currentJob = await prisma.printJob.findUnique({ where: { shortId: jobId } });
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
          include: { document: true }
        });
      } catch (err) {
        logger.error(`Failed to update job ${jobId} to FAILED:`, err);
        io.to(`machine_${socket.machineId}`).emit('job_status_changed', { id: 'error', shortId: jobId, status: 'FAILED', error });
      }
    });

    socket.on('disconnect', async () => {
      logger.info(`User disconnected: ${socket.id} (Type: ${socket.userType})`);
      if (socket.userType === 'printer' && socket.machineId) {
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
            io.to('admins').emit('printer_status_update', payload);
          }
        } catch (err) {
          logger.error('Error broadcasting printer disconnect:', err);
        }
      }
    });
  });
};

module.exports = setupSockets;
