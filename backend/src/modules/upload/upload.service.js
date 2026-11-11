const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const mammoth = require('mammoth');
const officeParser = require('officeparser');
const logger = require('../../utils/logger');
const AppError = require('../../utils/AppError');

const withTimeout = (promise, ms) => {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Operation timed out (possible decompression bomb)')), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
};

const getFileBuffer = async (fileUrl, localPath) => {
  if (localPath && fs.existsSync(localPath)) {
    return fs.readFileSync(localPath);
  }
  
  // Check if fileUrl references a local upload on disk
  if (fileUrl && fileUrl.includes('/uploads/')) {
    const filename = path.basename(fileUrl);
    const diskPath = path.join(__dirname, '../../../uploads', filename);
    if (fs.existsSync(diskPath)) {
      return fs.readFileSync(diskPath);
    }
  }

  // External S3 or remote file URL
  const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return response.data;
};

const getPageCount = async (fileUrl, mimetype, isEncrypted = false, claimedPages = 1, localPath = null) => {
  if (isEncrypted) {
    logger.info(`E2E Encrypted file detected. Bypassing server-side parse. Claimed pages: ${claimedPages}`);
    return claimedPages;
  }
  
  const isPdf = mimetype === 'application/pdf' || (fileUrl && fileUrl.toLowerCase().endsWith('.pdf'));

  if (isPdf) {
    const buffer = await getFileBuffer(fileUrl, localPath);
    if (!buffer || buffer.length < 5 || buffer.toString('utf8', 0, 5) !== '%PDF-') {
      throw new AppError('Invalid or corrupted PDF file: missing standard PDF header (%PDF-)', 400);
    }
    try {
      const pdfDoc = await PDFDocument.load(buffer);
      const pages = pdfDoc.getPageCount();
      if (pages < 1) {
        throw new AppError('Invalid PDF file: contains 0 pages', 400);
      }
      return pages;
    } catch (pdfErr) {
      if (pdfErr instanceof AppError) throw pdfErr;
      throw new AppError(`Invalid or corrupted PDF file: ${pdfErr.message}`, 400);
    }
  }

  try {
    if (mimetype && mimetype.includes('image/')) {
      return 1;
    }
    else if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const buffer = await getFileBuffer(fileUrl, localPath);
      const result = await withTimeout(mammoth.extractRawText({ buffer }), 5000);
      const text = result.value;
      const wordCount = text.split(/\s+/).filter(word => word.length > 0).length;
      const estimatedPages = Math.max(1, Math.ceil(wordCount / 400));
      logger.info(`DOCX page estimation: ${wordCount} words → ${estimatedPages} pages`);
      return estimatedPages;
    }
    else if (mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      const buffer = await getFileBuffer(fileUrl, localPath);
      const text = await withTimeout(officeParser.parseOfficeAsync(buffer), 5000);
      const slideBlocks = text.split(/\n\n+/).filter(block => block.trim().length > 0);
      const slideCount = Math.max(1, slideBlocks.length);
      logger.info(`PPTX slide estimation: ${slideCount} slides detected`);
      return slideCount;
    }
  } catch (err) {
    logger.warn('Warning getting page count, defaulting to 1:', err.message);
    return 1; // Safe fallback for non-PDF formats
  }
  return 1;
};

module.exports = {
  getPageCount
};
