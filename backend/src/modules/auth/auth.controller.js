const authService = require('./auth.service');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../../utils/prisma');
const AppError = require('../../utils/AppError');
const logger = require('../../utils/logger');
const { getPricingProfile, serializePublicPricingProfile } = require('../../services/pricing.service');
const { resolveCashfreeEnv } = require('../../config/cashfree.config');
const { isDemoPaymentPermitted, isDemoAccessCodeRequired } = require('../../utils/demoPaymentGuard');
const { DEFAULT_PAYMENT_MODE } = require('../../constants/paymentModes');
const { getMachineAvailability } = require('../../services/printerAvailability.service');

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { user, token } = await authService.login(email, password);

    res.cookie('jwt', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 90 * 24 * 60 * 60 * 1000 // 90 days
    });

    user.password = undefined; // Do not send password back

    res.status(200).json({
      success: true,
      token,
      user
    });
  } catch (error) {
    next(error);
  }
};

const activateAccount = async (req, res, next) => {
  try {
    const { token, password } = req.body;
    const { user, token: authToken } = await authService.activateAccount(token, password);

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');

    res.cookie('jwt', authToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 90 * 24 * 60 * 60 * 1000 // 90 days
    });

    user.password = undefined;

    res.status(200).json({
      success: true,
      message: 'Account successfully activated',
      token: authToken,
      user
    });
  } catch (error) {
    next(error);
  }
};

const logout = (req, res) => {
  res.cookie('jwt', 'loggedout', {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true
  });
  res.status(200).json({ success: true, message: 'Logged out successfully' });
};

const getMe = async (req, res, next) => {
  try {
    const user = await authService.getMe(req.user.id);
    user.password = undefined;
    res.status(200).json({ success: true, user });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/session/create
 * Called by the KIOSK to create a new session.
 * Server generates the session code (displayed in QR), stores it in DB.
 * Returns: { sessionCode, sessionToken }
 */
const createSession = async (req, res, next) => {
  try {
    let { machineId } = req.body;
    let assignedMachineId = machineId;
    let tempMachineKey; // Hoisted for temp extraction

    // If machineId is provided, verify it exists and is active
    if (assignedMachineId) {
      const machine = await prisma.machine.findUnique({ where: { id: assignedMachineId } });
      if (!machine) {
        return next(new AppError('Machine not found', 404));
      }
      if (machine.status === 'SUSPENDED') {
        return next(new AppError('Machine is suspended', 403));
      }
      tempMachineKey = machine.machineKey;
    } else {
      // Fallback for kiosk testing without explicit URL parameters:
      const firstMachine = await prisma.machine.findFirst({ where: { status: 'ACTIVE' } });
      if (firstMachine) {
        assignedMachineId = firstMachine.id;
        tempMachineKey = firstMachine.machineKey;
        logger.info(`No machineId provided for session; falling back to first active machine: ${assignedMachineId}`);
      }
    }

    // Generate a cryptographically secure session code (12 hex chars = 6 bytes = 281 trillion combinations)
    const sessionCode = crypto.randomBytes(6).toString('hex');

    // Session expires in 1 hour
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // Store session in database
    const session = await prisma.session.create({
      data: {
        code: sessionCode,
        machineId: assignedMachineId || null,
        status: 'WAITING_FOR_MOBILE',
        expiresAt,
      }
    });

    // Issue a session token for the kiosk
    const sessionToken = jwt.sign(
      { sessionId: session.code, machineId: assignedMachineId || null, type: 'session', role: 'kiosk' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    logger.info(`Session created: ${session.code} (machine: ${machineId || 'none'})`);

    res.status(200).json({
      success: true,
      sessionCode: session.code,
      sessionToken
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/session/join
 * Called by the MOBILE phone after scanning the QR code.
 * Validates the session exists, is active, and not expired.
 * Returns: { sessionToken }
 */
const joinSession = async (req, res, next) => {
  try {
    const { sessionCode } = req.body;

    if (!sessionCode) {
      return next(new AppError('sessionCode is required', 400));
    }

    // Look up the session in the database
    const session = await prisma.session.findUnique({ where: { code: sessionCode } });

    if (!session) {
      return next(new AppError('Invalid session code', 404));
    }

    if (session.status === 'EXPIRED' || session.status === 'COMPLETED') {
      return next(new AppError('This session has expired. Please scan a new QR code.', 410));
    }

    if (new Date() > session.expiresAt) {
      // Mark as expired in DB
      await prisma.session.update({
        where: { id: session.id },
        data: { status: 'EXPIRED' }
      });
      return next(new AppError('This session has expired. Please scan a new QR code.', 410));
    }

    // Update session status to CONNECTED
    await prisma.session.update({
      where: { id: session.id },
      data: { status: 'CONNECTED' }
    });

    // Issue a session token for the mobile user
    const sessionToken = jwt.sign(
      { sessionId: session.code, machineId: session.machineId || null, type: 'session', role: 'mobile' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const rawProfile = await getPricingProfile(session.machineId || null);
    const pricingProfile = serializePublicPricingProfile(rawProfile);
    const { env: cashfreeEnv } = resolveCashfreeEnv();

    let printer = null;
    if (session.machineId) {
      const availability = await getMachineAvailability(session.machineId, prisma);
      if (availability) {
        printer = {
          name: availability.name,
          model: availability.printerModel || 'EPSON L6460 Series',
          location: availability.location || 'Front Desk',
          isOnline: availability.isReady,
          hardwareStatus: availability.status,
          statusMessage: availability.statusMessage,
          agentOnline: availability.agentOnline,
          paperStatus: availability.paperStatus,
          tonerStatus: availability.tonerStatus,
          jamStatus: availability.jamStatus,
        };
      }
    }

    logger.info(`Mobile joined session: ${session.code} (printer: ${printer ? printer.hardwareStatus : 'none'})`);

    res.status(200).json({
      success: true,
      sessionToken,
      machineId: session.machineId,
      expiresAt: session.expiresAt,
      cashfreeEnv: cashfreeEnv || 'sandbox',
      pricingProfile,
      enableDemoPayment: isDemoPaymentPermitted(),
      demoAccessCodeRequired: isDemoPaymentPermitted() && isDemoAccessCodeRequired(),
      printer,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/auth/session/from-printer-qr
 * Called when mobile customer scans a permanent physical printer QR code (/p/:publicCode).
 * Creates a fresh, isolated 60-minute customer session bound to the target printer.
 */
const createSessionFromPrinterQr = async (req, res, next) => {
  try {
    const { publicCode } = req.body;
    const printerQrService = require('../../services/printerQr.service');
    const result = await printerQrService.resolvePrinterQr(publicCode);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/auth/printer-qr/:publicCode
 * Public pre-scan lookup returning printer metadata.
 */
const getPublicPrinterQrInfo = async (req, res, next) => {
  try {
    const { publicCode } = req.params;
    const printerQrService = require('../../services/printerQr.service');
    const result = await printerQrService.getPublicPrinterQrInfo(publicCode);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/auth/pricing
 * Public sanitized pricing profile + Cashfree environment lookup (by publicCode or machineId).
 */
const getPublicPricing = async (req, res, next) => {
  try {
    const { publicCode, machineId } = req.query;
    let resolvedMachineId = machineId || null;

    if (!resolvedMachineId && publicCode && typeof publicCode === 'string') {
      const qr = await prisma.printerQr.findUnique({
        where: { publicCode: publicCode.trim() },
        select: { machineId: true }
      });
      if (qr?.machineId) {
        resolvedMachineId = qr.machineId;
      }
    }

    let resolvedPaymentMode = DEFAULT_PAYMENT_MODE;
    if (resolvedMachineId) {
      const machine = await prisma.machine.findUnique({
        where: { id: resolvedMachineId },
        select: { paymentMode: true }
      });
      if (machine?.paymentMode) {
        resolvedPaymentMode = machine.paymentMode;
      }
    }

    const rawProfile = await getPricingProfile(resolvedMachineId);
    const pricingProfile = serializePublicPricingProfile(rawProfile);
    const { env: cashfreeEnv } = resolveCashfreeEnv();

    res.status(200).json({
      success: true,
      paymentMode: resolvedPaymentMode,
      cashfreeEnv: cashfreeEnv || 'sandbox',
      pricingProfile,
      enableDemoPayment: resolvedPaymentMode === 'DEMO_SIMULATION' && isDemoPaymentPermitted(),
      demoAccessCodeRequired: resolvedPaymentMode === 'DEMO_SIMULATION' && isDemoPaymentPermitted() && isDemoAccessCodeRequired()
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  login,
  activateAccount,
  logout,
  getMe,
  createSession,
  joinSession,
  createSessionFromPrinterQr,
  getPublicPrinterQrInfo,
  getPublicPricing
};
