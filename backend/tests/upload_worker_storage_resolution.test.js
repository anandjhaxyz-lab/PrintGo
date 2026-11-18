const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('axios', () => ({
  get: jest.fn()
}));

const axios = require('axios');
const { PDFDocument } = require('pdf-lib');

const originalUploadsDir = process.env.UPLOADS_DIR;
const testUploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printgo-upload-worker-'));
process.env.UPLOADS_DIR = testUploadsDir;

const { getPageCount, getFileBuffer } = require('../src/modules/upload/upload.service');

const createPdfFile = async (filename, pageCount = 2) => {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    pdf.addPage();
  }
  const bytes = await pdf.save();
  const filePath = path.join(testUploadsDir, filename);
  fs.writeFileSync(filePath, bytes);
  return filePath;
};

describe('upload worker file storage resolution', () => {
  beforeEach(() => {
    axios.get.mockReset();
    axios.get.mockRejectedValue(new Error('Unexpected HTTP file fetch in local-storage test'));
  });

  afterAll(() => {
    fs.rmSync(testUploadsDir, { recursive: true, force: true });
    if (originalUploadsDir === undefined) {
      delete process.env.UPLOADS_DIR;
    } else {
      process.env.UPLOADS_DIR = originalUploadsDir;
    }
  });

  test('counts pages from the exact Multer localPath without an HTTP request', async () => {
    const filename = 'sess_test_session_local-path.pdf';
    const localPath = await createPdfFile(filename, 2);
    const pages = await getPageCount(
      `https://printgo-backend-staging.onrender.com/uploads/${filename}`,
      'application/pdf',
      false,
      1,
      localPath
    );

    expect(pages).toBe(2);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('legacy upload jobs resolve local files through configured UPLOADS_DIR', async () => {
    const filename = 'sess_test_session-configured-dir.pdf';
    await createPdfFile(filename, 3);
    const pages = await getPageCount(
      `https://printgo-backend-staging.onrender.com/uploads/${filename}`,
      'application/pdf'
    );

    expect(pages).toBe(3);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('fails clearly when a supplied localPath is missing instead of making an unauthenticated HTTP request', async () => {
    const missingPath = path.join(testUploadsDir, 'missing-upload.pdf');

    await expect(
      getFileBuffer(
        'https://printgo-backend-staging.onrender.com/uploads/missing-upload.pdf',
        missingPath
      )
    ).rejects.toThrow(/not available at the worker storage path/i);

    expect(axios.get).not.toHaveBeenCalled();
  });
});
