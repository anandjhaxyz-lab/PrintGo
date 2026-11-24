const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { protect, restrictTo } = require('../../middlewares/auth');
const { readOnlyGuard } = require('../../middlewares/readOnlyGuard');
const { getAdsUploadsDir, validateMediaFileSignature } = require('../../utils/storage');
const adController = require('./advertisements.controller');

const router = express.Router();

const ensureAdsUploadDir = () => {
  const adsDir = getAdsUploadsDir();
  if (!fs.existsSync(adsDir)) {
    fs.mkdirSync(adsDir, { recursive: true });
  }
  return adsDir;
};

// Multer storage for advertisements (aligned with UPLOADS_DIR and server.js /uploads/ads static mount)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    try {
      cb(null, ensureAdsUploadDir());
    } catch (err) {
      cb(err);
    }
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || 
                (file.mimetype.startsWith('video/') ? '.mp4' : '.jpg');
    cb(null, `ad_${uuidv4()}${ext}`);
  }
});

// File filter: images and videos only
const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/quicktime'
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed types: JPEG, PNG, WEBP, GIF, MP4, WEBM.`), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max (covers videos & high-res photos)
  }
});

const handleMulterUpload = (req, res, next) => {
  upload.single('media')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'File size exceeds maximum allowed limit of 50MB.' });
      }
      return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ success: false, error: err.message || 'File upload rejected.' });
    }
    next();
  });
};

const verifyMediaSignatureMiddleware = async (req, res, next) => {
  if (!req.file) {
    return next();
  }
  try {
    const result = await validateMediaFileSignature(req.file.path, req.file.mimetype);
    if (!result.isValid) {
      try {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      } catch (unlinkErr) {}
      return res.status(400).json({
        success: false,
        error: result.error || 'File contents do not match expected media format (invalid magic bytes).'
      });
    }
    next();
  } catch (err) {
    try {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch (unlinkErr) {}
    return res.status(400).json({
      success: false,
      error: err.message || 'Media file signature validation failed.'
    });
  }
};

// ==============================================
// PUBLIC CUSTOMER ROUTES (No auth required)
// ==============================================
router.get('/active', adController.getActiveAdvertisements);
router.get('/', adController.getActiveAdvertisements);

// ==============================================
// PROTECTED OWNER / ADMIN ROUTES
// ==============================================
router.get('/admin/all', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), adController.getAllAdvertisements);
router.post('/admin', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), readOnlyGuard, handleMulterUpload, verifyMediaSignatureMiddleware, adController.createAdvertisement);
router.put('/admin/:id', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), readOnlyGuard, handleMulterUpload, verifyMediaSignatureMiddleware, adController.updateAdvertisement);
router.patch('/admin/reorder', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), readOnlyGuard, adController.reorderAdvertisements);
router.patch('/admin/:id/toggle', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), readOnlyGuard, adController.toggleActive);
router.delete('/admin/:id', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), readOnlyGuard, adController.deleteAdvertisement);

module.exports = router;
