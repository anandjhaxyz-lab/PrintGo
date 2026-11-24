const path = require('path');
const fs = require('fs');
const { Queue, QueueEvents } = require('bullmq');
const { connection } = require('../../services/redisClient');
const uploadService = require('./upload.service');
const { deleteFile, getUploadsDir } = require('../../utils/storage');
const AppError = require('../../utils/AppError');
const logger = require('../../utils/logger');

let uploadQueue = null;
let uploadQueueEvents = null;
let uploadQueueReady = false;

if (connection) {
  uploadQueue = new Queue('uploadQueue', { connection });
  // Reuse one QueueEvents consumer instead of leaking one Redis connection per upload.
  uploadQueueEvents = new QueueEvents('uploadQueue', { connection });
}

const waitForUploadQueueReady = async () => {
  if (!connection) return false;
  await Promise.all([
    uploadQueue.waitUntilReady(),
    uploadQueueEvents.waitUntilReady()
  ]);
  uploadQueueReady = true;
  return true;
};

const getUploadQueueHealth = () => ({
  configured: Boolean(connection && uploadQueue && uploadQueueEvents),
  ready: Boolean(connection && connection.status === 'ready' && uploadQueueReady)
});

const closeUploadQueue = async () => {
  uploadQueueReady = false;
  const events = uploadQueueEvents;
  const queue = uploadQueue;
  uploadQueueEvents = null;
  uploadQueue = null;
  if (events) await events.close();
  if (queue) await queue.close();
};

const handleUpload = async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400);
      throw new Error('No file uploaded.');
    }

    const fileUrl = req.file.location || `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;

    let pages = 1;
    const isEncrypted = req.body.isEncrypted === 'true';
    const claimedPages = parseInt(req.body.claimedPages) || 1;

    if (uploadQueue && !isEncrypted) {
      // A disk-backed upload must be read directly by the worker from the same
      // storage path. Fetching fileUrl over HTTP would hit the protected
      // /uploads/:filename route without an auth header and fail with 401.
      const job = await uploadQueue.add('countPages', {
        fileUrl,
        mimetype: req.file.mimetype,
        localPath: req.file.path || null
      });
      pages = await job.waitUntilFinished(uploadQueueEvents);
    } else {
      // Fallback or Encrypted bypass
      pages = await uploadService.getPageCount(fileUrl, req.file.mimetype, isEncrypted, claimedPages, req.file.path);
    }

    res.json({
      success: true,
      file: {
        filename: fileUrl,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        pages: pages
      }
    });
  } catch (error) {
    if (req.file) {
      deleteFile(req.file.location || req.file.path || req.file.filename).catch(() => {});
    }
    next(error);
  }
};

/**
 * Dedicated Authenticated Preview Endpoint
 * GET /api/upload/preview/:filename
 *
 * Strict Invariants:
 * 1. Session or User authentication required (HTTP 401).
 * 2. Session must be active and not expired based on TTL / status (HTTP 410).
 * 3. Exact server-side ownership enforcement (HTTP 403) - BOLA/IDOR protection.
 * 4. Path traversal prevention (HTTP 400).
 * 5. Safe inline streaming with Cache-Control: private, no-store.
 */
const handlePreview = async (req, res, next) => {
  try {
    const rawFilename = req.params.filename || '';
    const safeFilename = path.basename(rawFilename);

    if (!safeFilename || rawFilename !== safeFilename || rawFilename.includes('..')) {
      return next(new AppError('Invalid file path', 400));
    }

    // 1. Authorization & Server-Side Ownership Check
    const session = req.session;
    const user = req.user;

    if (!session && !user) {
      return next(new AppError('Authentication required. Please provide a session or user token.', 401));
    }

    if (session) {
      // Strictly verify server-side ownership prefix
      const isOwner = (session.id && safeFilename.startsWith(`sess_${session.id}_`)) ||
                      (session.code && safeFilename.startsWith(`sess_${session.code}_`)) ||
                      (session.sessionId && safeFilename.startsWith(`sess_${session.sessionId}_`));

      if (!isOwner) {
        logger.warn(`BOLA attempt blocked: Session ${session.id || session.code} tried to access unauthorized file ${safeFilename}`);
        return next(new AppError('Access denied: You do not have permission to view this file', 403));
      }
    } else if (user) {
      const isPrivileged = user.role === 'SUPERADMIN' || user.role === 'ADMIN';
      const isUserOwner = user.id && safeFilename.startsWith(`user_${user.id}_`);

      if (!isPrivileged && !isUserOwner) {
        logger.warn(`Unauthorized preview attempt: User ${user.id} tried to access file ${safeFilename}`);
        return next(new AppError('Access denied: You do not have permission to view this file', 403));
      }
    }

    // 2. Path Traversal & Disk Existence Validation
    const uploadsDir = getUploadsDir();
    const resolvedPath = path.resolve(uploadsDir, safeFilename);

    if (!resolvedPath.startsWith(path.resolve(uploadsDir))) {
      return next(new AppError('Invalid file path', 400));
    }

    if (!fs.existsSync(resolvedPath)) {
      return next(new AppError('File not found', 404));
    }

    // 3. Inline Media Streaming
    const ext = path.extname(safeFilename).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp'
    };

    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

    const stream = fs.createReadStream(resolvedPath);
    stream.on('error', (err) => {
      logger.error('Error streaming preview file:', err);
      if (!res.headersSent) {
        next(new AppError('Failed to read file from storage', 500));
      }
    });
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  handleUpload,
  handlePreview,
  waitForUploadQueueReady,
  getUploadQueueHealth,
  closeUploadQueue
};
