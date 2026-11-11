const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const uploadController = require('./upload.controller');
const AppError = require('../../utils/AppError');

const router = express.Router();

const { getStorage } = require('../../utils/storage');

const upload = multer({
  storage: getStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/x-pdf',
      'application/acrobat',
      'applications/vnd.pdf',
      'text/pdf',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
    ];
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];

    // Encrypted uploads use application/octet-stream — require a permitted underlying document/image extension
    if (file.mimetype === 'application/octet-stream') {
      if (allowedExts.includes(ext)) {
        return cb(null, true);
      }
      return cb(new AppError('Invalid encrypted file type. Allowed: PDF and Images (PNG, JPG, JPEG, WEBP)', 400), false);
    }

    const mimeAllowed = allowedTypes.includes(file.mimetype);
    const extAllowed = !ext || allowedExts.includes(ext);

    if (mimeAllowed && extAllowed) {
      cb(null, true);
    } else {
      cb(new AppError('Invalid file type. Only PDF and Images (PNG, JPG, JPEG, WEBP) are supported in this pilot.', 400), false);
    }
  }
});

const { requireSessionOrUser } = require('../../middlewares/session');

router.post('/', requireSessionOrUser, upload.single('file'), uploadController.handleUpload);

module.exports = router;
