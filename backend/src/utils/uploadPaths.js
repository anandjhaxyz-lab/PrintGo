const path = require('path');

// Keep the upload directory resolver dependency-light so upload workers
// can use it without loading storage adapters (for example multer-s3).
const getUploadsDir = () => process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');

module.exports = {
  getUploadsDir
};
