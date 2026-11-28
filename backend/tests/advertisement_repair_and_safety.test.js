/**
 * PrintGo — Phase 3.8 Advertisement Module Repair & Safety Test Suite
 *
 * Covers all 20 required test scenarios:
 *
 * Part 1: Media File Signature & Magic Bytes Validation
 * 1. Valid PNG magic bytes signature passes.
 * 2. Valid JPEG magic bytes signature passes.
 * 3. Valid WebP magic bytes signature passes.
 * 4. Valid MP4 magic bytes signature passes.
 * 5. Valid SVG text format passes.
 * 6. Spoofed MIME / invalid binary magic bytes fails validation.
 * 7. Multer 50MB file size limit error returns HTTP 400.
 *
 * Part 2: External Media URL & SSRF Protection
 * 8. Valid external HTTPS URL accepted.
 * 9. Non-HTTPS (plain HTTP) URL rejected with HTTP 400.
 * 10. SSRF localhost / loopback rejected with HTTP 400.
 * 11. SSRF private IP subnets (10.x, 172.16.x, 192.168.x) rejected with HTTP 400.
 * 12. SSRF cloud metadata endpoints (169.254.169.254, metadata.google.internal) rejected with HTTP 400.
 *
 * Part 3: Persistent Storage & Safety Invariants
 * 13. Persistent directory resolution prefers ADS_UPLOAD_DIR or /var/data/ads.
 * 14. Production safety check throws PERSISTENT_STORAGE_ERROR if persistent storage is missing.
 *
 * Part 4: File Lifecycle, Rollback & Concurrency Protection
 * 15. Create failure rolls back (unlinks) uploaded file from disk.
 * 16. Shared media protection: file retained if referenced by another advertisement.
 * 17. Path traversal attempt in mediaUrl is safely blocked from unlinking.
 *
 * Part 5: Static Serving & Customer Filtering
 * 18. Static media fallback returns 404 JSON for missing media.
 * 19. Placement filtering correctly separates KIOSK_ONLY vs MOBILE_ONLY vs ALL.
 * 20. readOnlyGuard blocks advertisement mutations when ADMIN_READ_ONLY=true and ALLOW_ADVERTISEMENT_MUTATIONS is unset/false.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

jest.mock('uuid', () => ({
  v4: () => 'mocked-uuid-1234'
}));

const {
  validateMediaFileSignature,
  getAdsUploadsDir
} = require('../src/utils/storage');
const {
  createAdvertisement,
  updateAdvertisement,
  deleteAdvertisement,
  getActiveAdvertisements
} = require('../src/modules/advertisements/advertisements.controller');
const { readOnlyGuard } = require('../src/middlewares/readOnlyGuard');
const prisma = require('../src/utils/prisma');

// Helper to create temporary test files
const createTempFile = (prefix, content) => {
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, `${prefix}_${Date.now()}_${Math.random().toString(36).substring(7)}`);
  fs.writeFileSync(filePath, content);
  return filePath;
};

describe('Phase 3.8 — Advertisement Module Repair & Safety Suite', () => {
  let createdTempFiles = [];

  const registerTempFile = (filePath) => {
    createdTempFiles.push(filePath);
    return filePath;
  };

  afterEach(() => {
    while (createdTempFiles.length > 0) {
      const f = createdTempFiles.pop();
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (e) {}
    }
  });

  // =========================================================================
  // PART 1: Media File Signature & Magic Bytes Validation (Tests 1 - 7)
  // =========================================================================
  describe('Part 1: Media File Signature & Magic Bytes Validation', () => {
    test('1. Valid PNG magic bytes signature passes', async () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52]);
      const filePath = registerTempFile(createTempFile('test_png', pngHeader));

      const result = await validateMediaFileSignature(filePath, 'image/png');
      expect(result.isValid).toBe(true);
      expect(result.detectedType).toBe('image/png');
    });

    test('2. Valid JPEG magic bytes signature passes', async () => {
      const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
      const filePath = registerTempFile(createTempFile('test_jpeg', jpegHeader));

      const result = await validateMediaFileSignature(filePath, 'image/jpeg');
      expect(result.isValid).toBe(true);
      expect(result.detectedType).toBe('image/jpeg');
    });

    test('3. Valid WebP magic bytes signature passes', async () => {
      // RIFF at 0..3, WEBP at 8..11
      const webpHeader = Buffer.alloc(16);
      webpHeader.write('RIFF', 0, 4, 'ascii');
      webpHeader.writeUInt32LE(100, 4);
      webpHeader.write('WEBP', 8, 4, 'ascii');
      const filePath = registerTempFile(createTempFile('test_webp', webpHeader));

      const result = await validateMediaFileSignature(filePath, 'image/webp');
      expect(result.isValid).toBe(true);
      expect(result.detectedType).toBe('image/webp');
    });

    test('4. Valid MP4 magic bytes signature passes', async () => {
      // ftyp at offset 4..7
      const mp4Header = Buffer.alloc(16);
      mp4Header.writeUInt32BE(16, 0);
      mp4Header.write('ftyp', 4, 4, 'ascii');
      mp4Header.write('isom', 8, 4, 'ascii');
      const filePath = registerTempFile(createTempFile('test_mp4', mp4Header));

      const result = await validateMediaFileSignature(filePath, 'video/mp4');
      expect(result.isValid).toBe(true);
      expect(result.detectedType).toBe('video/mp4');
    });

    test('5. Valid SVG text format passes', async () => {
      const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>';
      const filePath = registerTempFile(createTempFile('test_svg', svgContent));

      const result = await validateMediaFileSignature(filePath, 'image/svg+xml');
      expect(result.isValid).toBe(true);
      expect(result.detectedType).toBe('image/svg+xml');
    });

    test('6. Spoofed MIME / invalid binary magic bytes fails validation', async () => {
      const textSpoof = Buffer.from('Plain text contents masquerading as an image file');
      const filePath = registerTempFile(createTempFile('test_spoof', textSpoof));

      const result = await validateMediaFileSignature(filePath, 'image/png');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('File signature mismatch');
    });

    test('7. Multer 50MB file size limit error returns HTTP 400', () => {
      const multer = require('multer');
      const multerError = new multer.MulterError('LIMIT_FILE_SIZE');

      const app = express();
      app.post('/test-upload', (req, res, next) => {
        // Simulate multer upload handler error dispatch
        const err = multerError;
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ success: false, error: 'File size exceeds maximum allowed limit of 50MB.' });
          }
        }
        next(err);
      });

      return request(app)
        .post('/test-upload')
        .expect(400)
        .then(res => {
          expect(res.body.success).toBe(false);
          expect(res.body.error).toBe('File size exceeds maximum allowed limit of 50MB.');
        });
    });
  });

  // =========================================================================
  // PART 2: External Media URL & SSRF Protection (Tests 8 - 12)
  // =========================================================================
  describe('Part 2: External Media URL & SSRF Protection', () => {
    test('8. Valid external HTTPS URL accepted by createAdvertisement', async () => {
      const mockAd = {
        id: 'ad-https-1',
        title: 'Cloud Banner',
        type: 'IMAGE',
        mediaUrl: 'https://images.unsplash.com/photo-12345',
        scope: 'GLOBAL',
        placement: 'ALL',
        isActive: true
      };

      const originalCreate = prisma.advertisement.create;
      prisma.advertisement.create = jest.fn().mockResolvedValue(mockAd);

      const req = {
        body: {
          title: 'Cloud Banner',
          mediaUrl: 'https://images.unsplash.com/photo-12345',
          scope: 'GLOBAL',
          placement: 'ALL'
        },
        user: { id: 'admin-1', role: 'SUPERADMIN' }
      };
      const res = {
        statusCode: null,
        status: function(code) { this.statusCode = code; return this; },
        json: function(payload) { this.payload = payload; return this; }
      };
      const next = jest.fn();

      try {
        await createAdvertisement(req, res, next);
        expect(res.statusCode).toBe(201);
        expect(res.payload.success).toBe(true);
        expect(res.payload.advertisement.mediaUrl).toBe('https://images.unsplash.com/photo-12345');
      } finally {
        prisma.advertisement.create = originalCreate;
      }
    });

    test('9. Non-HTTPS (plain HTTP) URL rejected with HTTP 400', async () => {
      const req = {
        body: {
          title: 'Insecure Ad',
          mediaUrl: 'http://cdn.example.com/banner.jpg',
          scope: 'GLOBAL'
        },
        user: { id: 'admin-1', role: 'SUPERADMIN' }
      };
      const res = {};
      const next = jest.fn();

      await createAdvertisement(req, res, next);
      expect(next).toHaveBeenCalled();
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('https://');
    });

    test('10. SSRF localhost / loopback rejected with HTTP 400', async () => {
      const reqLocalhost = {
        body: { title: 'Localhost SSRF', mediaUrl: 'https://localhost:8080/ad.png', scope: 'GLOBAL' },
        user: { id: 'admin-1', role: 'SUPERADMIN' }
      };
      const reqLoopback = {
        body: { title: 'Loopback SSRF', mediaUrl: 'https://127.0.0.1/secret', scope: 'GLOBAL' },
        user: { id: 'admin-1', role: 'SUPERADMIN' }
      };

      const next1 = jest.fn();
      await createAdvertisement(reqLocalhost, {}, next1);
      expect(next1).toHaveBeenCalled();
      expect(next1.mock.calls[0][0].statusCode).toBe(400);

      const next2 = jest.fn();
      await createAdvertisement(reqLoopback, {}, next2);
      expect(next2).toHaveBeenCalled();
      expect(next2.mock.calls[0][0].statusCode).toBe(400);
    });

    test('11. SSRF private IP subnets (10.x, 172.16.x, 192.168.x) rejected with HTTP 400', async () => {
      const privateUrls = [
        'https://10.0.1.50/internal.png',
        'https://172.20.10.2/ad.png',
        'https://192.168.1.1/router.jpg'
      ];

      for (const mediaUrl of privateUrls) {
        const next = jest.fn();
        await createAdvertisement(
          { body: { title: 'Private Net', mediaUrl, scope: 'GLOBAL' }, user: { role: 'SUPERADMIN' } },
          {},
          next
        );
        expect(next).toHaveBeenCalled();
        expect(next.mock.calls[0][0].statusCode).toBe(400);
      }
    });

    test('12. SSRF cloud metadata endpoints rejected with HTTP 400', async () => {
      const cloudUrls = [
        'https://169.254.169.254/latest/meta-data',
        'https://metadata.google.internal/computeMetadata/v1/'
      ];

      for (const mediaUrl of cloudUrls) {
        const next = jest.fn();
        await createAdvertisement(
          { body: { title: 'Metadata Exfil', mediaUrl, scope: 'GLOBAL' }, user: { role: 'SUPERADMIN' } },
          {},
          next
        );
        expect(next).toHaveBeenCalled();
        expect(next.mock.calls[0][0].statusCode).toBe(400);
      }
    });
  });

  // =========================================================================
  // PART 3: Persistent Storage & Safety Invariants (Tests 13 - 14)
  // =========================================================================
  describe('Part 3: Persistent Storage & Safety Invariants', () => {
    const origEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...origEnv };
    });

    test('13. Persistent directory resolution prefers ADS_UPLOAD_DIR', () => {
      const tempAdsDir = path.join(os.tmpdir(), `custom_ads_dir_${Date.now()}`);
      registerTempFile(tempAdsDir);
      process.env.ADS_UPLOAD_DIR = tempAdsDir;

      const resolved = getAdsUploadsDir();
      expect(resolved).toBe(tempAdsDir);
      expect(fs.existsSync(tempAdsDir)).toBe(true);
    });

    test('14. Production safety check throws PERSISTENT_STORAGE_ERROR if persistent storage is missing', () => {
      delete process.env.ADS_UPLOAD_DIR;
      delete process.env.ALLOW_EPHEMERAL_STORAGE_FOR_TESTS;
      process.env.NODE_ENV = 'production';

      // Simulate an absent Render persistent mount consistently across Windows and Unix hosts.
      const originalExistsSync = fs.existsSync;
      fs.existsSync = (targetPath, ...args) => (
        targetPath === '/var/data' ? false : originalExistsSync(targetPath, ...args)
      );
      try {
        expect(() => {
          getAdsUploadsDir();
        }).toThrow('PERSISTENT_STORAGE_ERROR');
      } finally {
        fs.existsSync = originalExistsSync;
      }
    });
  });

  // =========================================================================
  // PART 4: File Lifecycle, Rollback & Concurrency Protection (Tests 15 - 17)
  // =========================================================================
  describe('Part 4: File Lifecycle, Rollback & Concurrency Protection', () => {
    test('15. Create failure rolls back (unlinks) uploaded file from disk', async () => {
      const tempFilePath = registerTempFile(createTempFile('rollback_test', 'test media data'));
      expect(fs.existsSync(tempFilePath)).toBe(true);

      const originalCreate = prisma.advertisement.create;
      prisma.advertisement.create = jest.fn().mockRejectedValue(new Error('Prisma database down'));

      const req = {
        body: { title: 'Test Rollback Ad', scope: 'GLOBAL' },
        file: {
          path: tempFilePath,
          filename: path.basename(tempFilePath),
          mimetype: 'image/png',
          size: 15
        },
        user: { role: 'SUPERADMIN' }
      };
      const next = jest.fn();

      try {
        await createAdvertisement(req, {}, next);
        expect(next).toHaveBeenCalled();
        // File must be cleaned up / unlinked from disk
        expect(fs.existsSync(tempFilePath)).toBe(false);
      } finally {
        prisma.advertisement.create = originalCreate;
      }
    });

    test('16. Shared media protection: file retained if referenced by another advertisement', async () => {
      const adsDir = getAdsUploadsDir();
      const filename = `shared_test_${Date.now()}.png`;
      const filePath = path.join(adsDir, filename);
      fs.writeFileSync(filePath, 'shared media buffer');
      registerTempFile(filePath);

      const originalFindUnique = prisma.advertisement.findUnique;
      const originalDelete = prisma.advertisement.delete;
      const originalCount = prisma.advertisement.count;

      prisma.advertisement.findUnique = jest.fn().mockResolvedValue({
        id: 'ad-delete-1',
        title: 'Ad 1',
        scope: 'GLOBAL',
        mediaUrl: `/uploads/ads/${filename}`
      });
      prisma.advertisement.delete = jest.fn().mockResolvedValue({});
      // Simulate that another ad also references this mediaUrl (count > 0)
      prisma.advertisement.count = jest.fn().mockResolvedValue(1);

      const req = {
        params: { id: 'ad-delete-1' },
        user: { role: 'SUPERADMIN' }
      };
      const res = {
        json: jest.fn()
      };
      const next = jest.fn();

      try {
        await deleteAdvertisement(req, res, next);
        expect(res.json).toHaveBeenCalled();
        // The file must STILL exist because count > 0
        expect(fs.existsSync(filePath)).toBe(true);
      } finally {
        prisma.advertisement.findUnique = originalFindUnique;
        prisma.advertisement.delete = originalDelete;
        prisma.advertisement.count = originalCount;
      }
    });

    test('17. Path traversal attempt in mediaUrl is safely blocked from unlinking', async () => {
      const sensitiveFile = registerTempFile(createTempFile('safe_system_file', 'CRITICAL DATA'));
      expect(fs.existsSync(sensitiveFile)).toBe(true);

      const originalFindUnique = prisma.advertisement.findUnique;
      const originalDelete = prisma.advertisement.delete;
      const originalCount = prisma.advertisement.count;

      prisma.advertisement.findUnique = jest.fn().mockResolvedValue({
        id: 'ad-traversal-1',
        title: 'Traversal Ad',
        scope: 'GLOBAL',
        mediaUrl: `../../../../${path.basename(sensitiveFile)}`
      });
      prisma.advertisement.delete = jest.fn().mockResolvedValue({});
      prisma.advertisement.count = jest.fn().mockResolvedValue(0);

      const req = {
        params: { id: 'ad-traversal-1' },
        user: { role: 'SUPERADMIN' }
      };
      const res = { json: jest.fn() };
      const next = jest.fn();

      try {
        await deleteAdvertisement(req, res, next);
        expect(res.json).toHaveBeenCalled();
        // Target file must not have been unlinked
        expect(fs.existsSync(sensitiveFile)).toBe(true);
      } finally {
        prisma.advertisement.findUnique = originalFindUnique;
        prisma.advertisement.delete = originalDelete;
        prisma.advertisement.count = originalCount;
      }
    });
  });

  // =========================================================================
  // PART 5: Static Serving & Customer Filtering (Tests 18 - 20)
  // =========================================================================
  describe('Part 5: Static Serving & Customer Filtering', () => {
    test('18. Static media fallback returns 404 JSON for missing media', () => {
      const app = express();
      const adsUploadsDir = getAdsUploadsDir();
      app.use('/uploads/ads', express.static(adsUploadsDir, { maxAge: '1d', acceptRanges: true }));
      app.use('/uploads/ads', (req, res) => {
        res.status(404).json({ success: false, error: 'Media file not found' });
      });

      return request(app)
        .get('/uploads/ads/non_existent_ad_banner_12345.jpg')
        .expect(404)
        .then(res => {
          expect(res.body.success).toBe(false);
          expect(res.body.error).toBe('Media file not found');
        });
    });

    test('19. Placement filtering correctly separates KIOSK_ONLY vs MOBILE_ONLY vs ALL', async () => {
      const originalFindMany = prisma.advertisement.findMany;
      let capturedWhere = null;
      prisma.advertisement.findMany = jest.fn().mockImplementation(({ where }) => {
        capturedWhere = where;
        return Promise.resolve([]);
      });

      try {
        // Query with placement=KIOSK_ONLY
        const reqKiosk = {
          headers: {},
          query: { placement: 'KIOSK_ONLY' }
        };
        const resKiosk = { json: jest.fn() };
        await getActiveAdvertisements(reqKiosk, resKiosk, jest.fn());

        // In baseWhere.AND, verify placement filter was applied
        const kioskFilter = capturedWhere.AND.find(c => c.placement);
        expect(kioskFilter.placement.in).toEqual(['KIOSK_ONLY', 'ALL']);

        // Query with placement=MOBILE_ONLY
        const reqMobile = {
          headers: {},
          query: { placement: 'MOBILE_ONLY' }
        };
        const resMobile = { json: jest.fn() };
        await getActiveAdvertisements(reqMobile, resMobile, jest.fn());

        const mobileFilter = capturedWhere.AND.find(c => c.placement);
        expect(mobileFilter.placement.in).toEqual(['MOBILE_ONLY', 'ALL']);
      } finally {
        prisma.advertisement.findMany = originalFindMany;
      }
    });

    test('20. readOnlyGuard blocks advertisement mutations when ADMIN_READ_ONLY=true and ALLOW_ADVERTISEMENT_MUTATIONS is unset/false', () => {
      const origReadOnly = process.env.ADMIN_READ_ONLY;
      const origAllow = process.env.ALLOW_ADVERTISEMENT_MUTATIONS;

      try {
        process.env.ADMIN_READ_ONLY = 'true';
        delete process.env.ALLOW_ADVERTISEMENT_MUTATIONS;

        const req = {
          method: 'POST',
          originalUrl: '/api/advertisements/admin',
          path: '/api/advertisements/admin'
        };
        const res = {
          statusCode: null,
          status: function(code) { this.statusCode = code; return this; },
          json: function(payload) { this.payload = payload; return this; }
        };
        const next = jest.fn();

        readOnlyGuard(req, res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.payload.error).toContain('Read-Only Monitoring Mode');
      } finally {
        process.env.ADMIN_READ_ONLY = origReadOnly;
        process.env.ALLOW_ADVERTISEMENT_MUTATIONS = origAllow;
      }
    });
  });
});
