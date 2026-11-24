const { S3Client, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');
const { getUploadsDir } = require('./uploadPaths');

// Only use S3 if the bucket is explicitly configured, regardless of environment
const useS3 = !!process.env.AWS_S3_BUCKET;

if (useS3 && !process.env.AWS_REGION) {
  logger.warn('WARNING: Running in S3 mode but AWS credentials or bucket are missing from .env!');
}

let s3Client;
if (useS3) {
  s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });
  logger.info('Storage Service initialized with AWS S3');
} else {
  logger.info('Storage Service initialized with Local Disk (AWS_S3_BUCKET not set)');
}

const getSafeExtension = (mimetype) => {
  const map = {
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'image/jpeg': '.jpg',
    'image/png': '.png'
  };
  return map[mimetype] || '.bin';
};

/**
 * Resolves the durable persistent advertisement upload directory.
 * Hierarchy:
 * 1. process.env.ADS_UPLOAD_DIR (explicit configurable path)
 * 2. /var/data/ads if persistent disk /var/data is mounted (e.g. Render Staging)
 * 3. Local fallback for development/testing: path.join(getUploadsDir(), 'ads')
 *
 * Safety Invariant: In deployed production/staging environments (NODE_ENV === 'production' or RENDER === 'true'),
 * if persistent storage cannot be verified (/var/data is absent and ADS_UPLOAD_DIR is unset),
 * it fails closed rather than silently writing to ephemeral container disk!
 */
const getAdsUploadsDir = () => {
  if (process.env.ADS_UPLOAD_DIR) {
    const customDir = path.resolve(process.env.ADS_UPLOAD_DIR);
    if (!fs.existsSync(customDir)) {
      fs.mkdirSync(customDir, { recursive: true });
    }
    return customDir;
  }

  // Check for mounted Render persistent disk at /var/data
  if (fs.existsSync('/var/data')) {
    const persistentAdsDir = '/var/data/ads';
    if (!fs.existsSync(persistentAdsDir)) {
      try {
        fs.mkdirSync(persistentAdsDir, { recursive: true });
      } catch (err) {
        logger.error('Failed to create persistent advertisement directory at /var/data/ads:', err);
      }
    }
    return persistentAdsDir;
  }

  // Production safety check: do not silently use ephemeral container storage on Render
  const isDeployedEnv = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
  if (isDeployedEnv && !process.env.ALLOW_EPHEMERAL_STORAGE_FOR_TESTS) {
    throw new Error(
      'PERSISTENT_STORAGE_ERROR: Persistent disk not detected at /var/data and ADS_UPLOAD_DIR is not configured. ' +
      'Refusing to silently write advertisement media to ephemeral container storage in production.'
    );
  }

  // Local development / testing fallback
  const fallbackDir = path.join(getUploadsDir(), 'ads');
  if (!fs.existsSync(fallbackDir)) {
    fs.mkdirSync(fallbackDir, { recursive: true });
  }
  return fallbackDir;
};

/**
 * Validates file magic bytes (signatures) to prevent MIME spoofing.
 * Supports: JPEG, PNG, WEBP, GIF, SVG, MP4, WebM.
 *
 * @param {string} filePath - Absolute path to uploaded file on disk
 * @param {string} declaredMime - Declared Content-Type / MIME
 * @returns {Promise<{ isValid: boolean, detectedType: string, error?: string }>}
 */
const validateMediaFileSignature = async (filePath, declaredMime) => {
  if (!filePath || !fs.existsSync(filePath)) {
    return { isValid: false, detectedType: 'UNKNOWN', error: 'File does not exist on disk' };
  }

  const fd = await fs.promises.open(filePath, 'r');
  const buffer = Buffer.alloc(32);
  const { bytesRead } = await fd.read(buffer, 0, 32, 0);
  await fd.close();

  if (bytesRead < 4) {
    return { isValid: false, detectedType: 'CORRUPTED', error: 'File is empty or too small' };
  }

  // 1. JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { isValid: true, detectedType: 'image/jpeg' };
  }

  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A
  ) {
    return { isValid: true, detectedType: 'image/png' };
  }

  // 3. GIF: 47 49 46 38 ('GIF87a' or 'GIF89a')
  if (
    buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38
  ) {
    return { isValid: true, detectedType: 'image/gif' };
  }

  // 4. WEBP: 52 49 46 46 (RIFF) at offset 0, and 57 45 42 50 (WEBP) at offset 8
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return { isValid: true, detectedType: 'image/webp' };
  }

  // 5. MP4: 'ftyp' at offset 4 (66 74 79 70)
  if (
    buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70
  ) {
    return { isValid: true, detectedType: 'video/mp4' };
  }

  // 6. WebM: 1A 45 DF A3 (EBML header)
  if (
    buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3
  ) {
    return { isValid: true, detectedType: 'video/webm' };
  }

  // 7. SVG: UTF-8 text containing '<svg' or '<?xml'
  if (declaredMime === 'image/svg+xml') {
    const sample = buffer.toString('utf8', 0, bytesRead).trim().toLowerCase();
    if (sample.includes('<svg') || sample.includes('<?xml')) {
      return { isValid: true, detectedType: 'image/svg+xml' };
    }
  }

  return {
    isValid: false,
    detectedType: 'UNKNOWN',
    error: `File signature mismatch: binary does not match valid image or video formats (declared: ${declaredMime})`
  };
};

const getStorage = () => {
  if (useS3) {
    return multerS3({
      s3: s3Client,
      bucket: process.env.AWS_S3_BUCKET,
      metadata: function (req, file, cb) {
        cb(null, { fieldName: file.fieldname });
      },
      key: function (req, file, cb) {
        const ext = getSafeExtension(file.mimetype);
        const ownerPrefix = req.session?.id
          ? `sess_${req.session.id}_`
          : req.user?.id
            ? `user_${req.user.id}_`
            : '';
        cb(null, `uploads/${ownerPrefix}${uuidv4()}${ext}`);
      }
    });
  } else {
    return multer.diskStorage({
      destination: function (req, file, cb) {
        const uploadDir = getUploadsDir();
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
      },
      filename: function (req, file, cb) {
        const ext = getSafeExtension(file.mimetype);
        const ownerPrefix = req.session?.id
          ? `sess_${req.session.id}_`
          : req.user?.id
            ? `user_${req.user.id}_`
            : '';
        cb(null, `${ownerPrefix}${uuidv4()}${ext}`);
      }
    });
  }
};

const deleteFile = async (filename) => {
  if (!filename) return true;

  try {
    if (filename.startsWith('http') && filename.includes('amazonaws.com')) {
      // It's an S3 URL
      if (!useS3) {
        logger.warn(`Cannot delete S3 file ${filename} because S3 is not configured`);
        return false;
      }

      const url = new URL(filename);
      // Example url: https://bucket-name.s3.ap-south-1.amazonaws.com/uploads/uuid.pdf
      // Key is the pathname without the leading slash
      const key = url.pathname.substring(1);

      await s3Client.send(new DeleteObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key
      }));
      logger.info(`Deleted S3 file: ${key}`);
      return true;
    } else {
      // It's a local file
      const filePath = filename.startsWith('/')
        ? path.join(__dirname, '..', '..', filename)
        : path.join(getUploadsDir(), path.basename(filename));

      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        logger.info(`Deleted local file: ${filePath}`);
      }
      return true;
    }
  } catch (error) {
    logger.error(`Error deleting file ${filename}:`, error);
    return false;
  }
};

module.exports = {
  getUploadsDir,
  getAdsUploadsDir,
  getStorage,
  deleteFile,
  validateMediaFileSignature,
  useS3
};
