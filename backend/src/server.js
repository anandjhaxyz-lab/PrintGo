require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');

const logger = require('./utils/logger');
const { errorHandler } = require('./middlewares/error');
const setupSockets = require('./socket');

// Initialize Express App
const app = express();
app.set('trust proxy', 1);

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: 1.0, 
    profilesSampleRate: 1.0, 
  });
}

const { createAdapter } = require('@socket.io/redis-adapter');
const {
  connection,
  waitForRedisReady,
  getRedisHealth,
  closeRedisConnection
} = require('./services/redisClient');
const prisma = require('./utils/prisma');
const queueService = require('./services/queueService');
const uploadWorkerService = require('./services/uploadWorker');
const uploadQueueController = require('./modules/upload/upload.controller');

let redisAdapterSubClient = null;
let redisAdapterReady = false;

// --- CORS & Origin Configuration ---
// Strictly disallow localhost, LAN subnets, wildcards, and legacy origins in production runtime.
const DEV_LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:5174',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://192.168.1.2:5173'
];

const isLoopbackHostname = (hostname = '') => {
  const normalized = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
};

const parseConfiguredOrigins = (env = process.env, isProd = false) => {
  const rawSources = [
    env.ALLOWED_ORIGINS,
    env.FRONTEND_URL,
    env.PUBLIC_APP_URL,
    env.PUBLIC_FRONTEND_URL
  ];
  const validOrigins = [];

  for (const raw of rawSources) {
    if (!raw || typeof raw !== 'string') continue;
    for (const part of raw.split(',')) {
      const candidate = part.trim().replace(/\/+$/, '');
      if (!candidate) continue;

      if (candidate.includes('*')) {
        logger.warn(`Ignoring wildcard CORS origin entry: ${candidate}`);
        continue;
      }

      try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        if (isProd && isLoopbackHostname(parsed.hostname)) {
          logger.warn(`Ignoring localhost CORS origin in production runtime: ${candidate}`);
          continue;
        }
        validOrigins.push(parsed.origin);
      } catch {
        logger.warn(`Ignoring malformed CORS origin entry: ${candidate}`);
      }
    }
  }

  return validOrigins;
};

const createCorsOriginValidator = (env = process.env) => {
  const nodeEnv = (env.NODE_ENV || 'development').trim().toLowerCase();
  const isProd = nodeEnv === 'production';
  const configuredOrigins = parseConfiguredOrigins(env, isProd);
  const originsSet = new Set(isProd ? configuredOrigins : [...DEV_LOCAL_ORIGINS, ...configuredOrigins]);

  const validator = (origin, callback) => {
    // Allow non-browser clients (printer agent, Cashfree webhooks, curl, server-to-server)
    if (!origin) {
      return callback(null, true);
    }

    if (typeof origin !== 'string' || origin === 'null' || origin.includes('*')) {
      logger.warn('CORS access blocked for wildcard/invalid origin: ' + origin);
      return callback(new Error(`Origin '${origin}' not allowed by CORS policy`), false);
    }

    let normalizedOrigin;
    try {
      const parsed = new URL(origin);
      if (isProd && isLoopbackHostname(parsed.hostname)) {
        logger.warn('CORS access blocked for localhost origin in production: ' + origin);
        return callback(new Error(`Origin '${origin}' not allowed by CORS policy`), false);
      }
      normalizedOrigin = parsed.origin;
    } catch {
      logger.warn('CORS access blocked for malformed origin: ' + origin);
      return callback(new Error(`Origin '${origin}' not allowed by CORS policy`), false);
    }

    if (originsSet.has(normalizedOrigin)) {
      return callback(null, true);
    }

    // Local LAN subnet pattern for mobile kiosk testing strictly in non-production runtime
    if (!isProd && /^http:\/\/192\.168\.\d+\.\d+:5173$/.test(normalizedOrigin)) {
      return callback(null, true);
    }

    logger.warn('CORS access blocked for unauthorized origin: ' + origin);
    return callback(new Error(`Origin '${origin}' not allowed by CORS policy`), false);
  };

  return { allowedOriginsSet: originsSet, corsOriginValidator: validator };
};

const { allowedOriginsSet, corsOriginValidator } = createCorsOriginValidator(process.env);

// Server & Socket.IO Setup
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOriginValidator,
    methods: ["GET", "POST", "PUT"],
    credentials: true
  }
});

const initializeRedisAdapter = async () => {
  if (process.env.ENABLE_REDIS_ADAPTER !== 'true') {
    logger.info('Socket.IO Redis adapter disabled; using the single-instance in-memory adapter.');
    return false;
  }

  if (!connection) {
    throw new Error('ENABLE_REDIS_ADAPTER=true requires REDIS_URL or REDIS_HOST.');
  }

  redisAdapterSubClient = connection.duplicate();
  redisAdapterSubClient.on('error', (err) => {
    logger.error('Socket.IO Redis subscriber connection error:', err.message);
  });

  try {
    await redisAdapterSubClient.ping();
    io.adapter(createAdapter(connection, redisAdapterSubClient));
    redisAdapterReady = true;
    logger.info('Redis adapter attached to Socket.IO');
    return true;
  } catch (error) {
    redisAdapterReady = false;
    if (process.env.NODE_ENV === 'production' || process.env.QUEUE_REDIS_REQUIRED === 'true') {
      throw new Error(`Socket.IO Redis adapter failed to initialize: ${error.message}`);
    }
    logger.warn('Socket.IO Redis adapter failed in development/test:', error.message);
    return false;
  }
};

app.set('io', io);
global.io = io;
setupSockets(io);

// Security & Middlewares
app.use(helmet());
app.use(cors({
  origin: corsOriginValidator,
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  message: 'Too many requests, please try again later.',
  skip: (req) => {
    const ip = req.ip || req.connection?.remoteAddress || '';
    return ip.includes('127.0.0.1') || ip.includes('192.168.');
  }
});
app.use('/api/', apiLimiter);

app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));
app.use(express.urlencoded({ limit: '2mb', extended: true }));
app.use(cookieParser());

// Uploads directory
const { fileAuth } = require('./middlewares/fileAuth');
const { serveDocument } = require('./modules/files/file.controller');
const { getAdsUploadsDir } = require('./utils/storage');
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}
// Public static media hosting for customer-facing promotional advertisements
const adsUploadsDir = getAdsUploadsDir();
app.use('/uploads/ads', express.static(adsUploadsDir, { maxAge: '1d', acceptRanges: true }));
app.use('/uploads/ads', (req, res) => {
  res.status(404).json({ success: false, error: 'Media file not found' });
});

app.get('/uploads/:filename', fileAuth, serveDocument);

// Permanent Printer QR Customer Landing Redirect
app.get('/p/:publicCode', (req, res) => {
  const { publicCode } = req.params;
  const frontendUrl = (process.env.PUBLIC_APP_URL || process.env.PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  if (frontendUrl) {
    return res.redirect(`${frontendUrl}/p/${publicCode}`);
  }
  res.redirect(`/m/qr?code=${publicCode}`);
});

// Health Check (Keep-Alive for Render Free Tier)
app.get('/api/health', (req, res) => {
  // Liveness only: Render can use this to determine whether the process is alive.
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/ready', async (req, res) => {
  const checks = {};
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    checks.database = 'ready';
  } catch (error) {
    checks.database = 'not_ready';
  }

  const redisStatus = getRedisHealth();
  const redisRequired =
    process.env.NODE_ENV === 'production' ||
    process.env.QUEUE_REDIS_REQUIRED === 'true';
  const queueInfrastructureRequired = redisRequired || redisStatus.configured;

  checks.redis = redisStatus.configured
    ? (redisStatus.ready ? 'ready' : 'not_ready')
    : (redisRequired ? 'not_ready' : 'not_required');

  const printQueueStatus = queueService.getQueueHealth();
  checks.printQueue = queueInfrastructureRequired
    ? (printQueueStatus.ready ? 'ready' : 'not_ready')
    : 'not_required';

  const uploadWorkerStatus = uploadWorkerService.getUploadWorkerHealth();
  checks.uploadWorker = queueInfrastructureRequired
    ? (uploadWorkerStatus.ready ? 'ready' : 'not_ready')
    : 'not_required';

  const uploadQueueStatus = uploadQueueController.getUploadQueueHealth();
  checks.uploadQueueEvents = queueInfrastructureRequired
    ? (uploadQueueStatus.ready ? 'ready' : 'not_ready')
    : 'not_required';

  const adapterEnabled = process.env.ENABLE_REDIS_ADAPTER === 'true';
  checks.socketIoRedisAdapter = adapterEnabled
    ? (redisAdapterReady ? 'ready' : 'not_ready')
    : 'disabled';

  const queueInfrastructureReady =
    !queueInfrastructureRequired ||
    (
      checks.redis === 'ready' &&
      checks.printQueue === 'ready' &&
      checks.uploadWorker === 'ready' &&
      checks.uploadQueueEvents === 'ready'
    );

  const ready =
    checks.database === 'ready' &&
    queueInfrastructureReady &&
    (!adapterEnabled || checks.socketIoRedisAdapter === 'ready');

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks,
    timestamp: new Date().toISOString()
  });
});

// Routes
const authRoutes = require('./modules/auth/auth.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const jobsRoutes = require('./modules/jobs/jobs.routes');
const uploadRoutes = require('./modules/upload/upload.routes');
const machinesRoutes = require('./modules/machines/machines.routes');
const companiesRoutes = require('./modules/companies/companies.routes');
const paymentsRoutes = require('./modules/payments/payments.routes');
const subscriptionsRoutes = require('./modules/subscriptions/subscriptions.routes');
const advertisementsRoutes = require('./modules/advertisements/advertisements.routes');

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/machines', machinesRoutes);
app.use('/api/companies', companiesRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/advertisements', advertisementsRoutes);

// Error Handling
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}
app.use(errorHandler);

const port = process.env.PORT || 5000;

// Auto-seed database on startup for fresh deployments
const autoSeed = async () => {
  try {
    const prisma = require('./utils/prisma');
    
    // Seed default machine only when a key has been explicitly configured.
    // Missing MACHINE_KEY must not block the Superadmin bootstrap below.
    const machineKey = process.env.MACHINE_KEY?.trim();
    if (machineKey) {
      const existingMachine = await prisma.machine.findUnique({ where: { machineKey }});
      if (!existingMachine) {
        await prisma.machine.create({
          data: {
            name: 'Main Shop Printer',
            location: 'Front Desk',
            machineKey,
            status: 'ACTIVE',
          }
        });
        logger.info('Auto-seeded default machine!');
      }
    } else {
      logger.info('Skipping default machine auto-seed: MACHINE_KEY is not configured. Register a machine from the admin panel.');
    }

    // Seed Admin
    const adminEmail = process.env.ADMIN_USER || 'superadmin@printgo.in';
    const adminPass = process.env.ADMIN_PASS;
    if (adminPass) {
      const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail }});
      if (!existingAdmin) {
        const bcrypt = require('bcrypt');
        const hashedPassword = await bcrypt.hash(adminPass, 12);
        await prisma.user.create({
          data: {
            name: 'PrintGo Admin',
            email: adminEmail,
            password: hashedPassword,
            role: 'SUPERADMIN'
          }
        });
        logger.info('Auto-seeded superadmin securely from environment');
      }
    }
  } catch (error) {
    logger.error('Error during auto-seed:', error);
  }
};

/**
 * Fail-Closed Database Identity Guard
 * Enforces that local server execution connects strictly to printgo_disposable_target on port 5433.
 * Aborts startup immediately BEFORE autoSeed() or any database mutation if targeting printgo_db or another DB.
 */
const verifyDatabaseIdentity = async () => {
  const isCloudEnv = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';
  if (isCloudEnv) return;

  const prisma = require('./utils/prisma');
  const meta = await prisma.$queryRawUnsafe('SELECT current_database(), inet_server_port();');
  const currentDb = meta[0]?.current_database;
  const currentPort = Number(meta[0]?.inet_server_port);

  if (currentDb !== 'printgo_disposable_target' || currentPort !== 5433) {
    const errorMsg = `[DATABASE SAFETY GUARD] FATAL: Server startup aborted. Connected to unauthorized database '${currentDb}' on port ${currentPort}. Local startup requires 'printgo_disposable_target' on port 5433.`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  logger.info(`[DATABASE SAFETY GUARD] Verified: Connected to '${currentDb}' on port ${currentPort}.`);
};

const startServer = async () => {
  // Preserve the existing local database identity guard before any seed writes.
  await verifyDatabaseIdentity();
  await autoSeed();

  if (connection) {
    await waitForRedisReady(15000);
  }

  await initializeRedisAdapter();
  await queueService.initWorker(io);
  await uploadWorkerService.initUploadWorker();
  await uploadQueueController.waitForUploadQueueReady();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      logger.info(`Enterprise PrintGo backend running at http://localhost:${port}`);
      resolve();
    });
  });
};

let shutdownStarted = false;
const shutdown = async (signal) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info(`Received ${signal}; beginning graceful PrintGo shutdown.`);

  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown exceeded 30 seconds; forcing process exit.');
    process.exit(1);
  }, 30000);
  forceExitTimer.unref();

  try {
    // Stop accepting sockets before closing workers and their shared Redis resources.
    await new Promise((resolve) => io.close(resolve));
    await Promise.all([
      queueService.closeQueueService(),
      uploadWorkerService.closeUploadWorker(),
      uploadQueueController.closeUploadQueue()
    ]);

    if (redisAdapterSubClient && redisAdapterSubClient.status !== 'end') {
      await redisAdapterSubClient.quit();
    }
    await closeRedisConnection();
    await prisma.$disconnect();
    process.exitCode = 0;
    logger.info('PrintGo graceful shutdown completed.');
  } catch (error) {
    process.exitCode = 1;
    logger.error('PrintGo graceful shutdown failed:', error);
  } finally {
    clearTimeout(forceExitTimer);
  }
};

if (require.main === module) {
  startServer().catch((error) => {
    logger.error('PrintGo startup failed; server will not accept traffic:', error);
    process.exit(1);
  });
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  app,
  server,
  io,
  corsOriginValidator,
  allowedOriginsSet,
  createCorsOriginValidator,
  parseConfiguredOrigins,
  isLoopbackHostname,
  verifyDatabaseIdentity,
  initializeRedisAdapter,
  startServer,
  shutdown
};
