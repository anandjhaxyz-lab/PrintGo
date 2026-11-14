/**
 * PRINTGO — PHASE 2 AUTOMATED TEST SUITE
 * Advertisement Architecture v2: Session Security, Ad Suppression & Priority Engine
 *
 * Fully mocked unit & integration tests running with Jest.
 * Zero database network connection required.
 */

process.env.JWT_SECRET = 'test_jwt_secret_ad_phase2_super_secure';

jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234'
}));

const jwt = require('jsonwebtoken');
const { resolveAuthoritativeSessionMachine, ALLOWED_SESSION_STATUSES } = require('../src/services/sessionSecurity.service');
const adSuppressionService = require('../src/services/adSuppression.service');
const adController = require('../src/modules/advertisements/advertisements.controller');
const prisma = require('../src/utils/prisma');

// Mock Prisma
jest.mock('../src/utils/prisma', () => ({
  session: {
    findUnique: jest.fn()
  },
  machine: {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  printerQr: {
    findUnique: jest.fn()
  },
  advertisement: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn()
  },
  activityLog: {
    create: jest.fn()
  },
  auditLog: {
    create: jest.fn()
  },
  $transaction: jest.fn((callbackOrArray) => {
    if (typeof callbackOrArray === 'function') {
      const p = require('../src/utils/prisma');
      return callbackOrArray(p);
    }
    return Promise.all(callbackOrArray);
  })
}));

describe('Phase 2 — Advertisement Architecture & Security Suite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // 1. HARDENED SESSION VALIDATOR (resolveAuthoritativeSessionMachine)
  // =========================================================================
  describe('1. Hardened Session Validator', () => {
    test('1.1 Genuinely absent Authorization header (undefined) allows anonymous GLOBAL access', async () => {
      const result = await resolveAuthoritativeSessionMachine({ authHeader: undefined });
      expect(result).toEqual({ isAnonymous: true, isUnbound: true, machine: null });
    });

    test('1.2 Empty string Authorization header ("") rejects with HTTP 401', async () => {
      await expect(resolveAuthoritativeSessionMachine({ authHeader: '' }))
        .rejects.toThrow('Empty or whitespace-only Authorization header is not permitted');
    });

    test('1.3 Whitespace-only Authorization header ("   ") rejects with HTTP 401', async () => {
      await expect(resolveAuthoritativeSessionMachine({ authHeader: '   ' }))
        .rejects.toThrow('Empty or whitespace-only Authorization header is not permitted');
    });

    test('1.4 Malformed scheme ("Basic xyz") rejects with HTTP 401', async () => {
      await expect(resolveAuthoritativeSessionMachine({ authHeader: 'Basic xyz' }))
        .rejects.toThrow('Expected "Bearer <token>" format');
    });

    test('1.5 Missing token ("Bearer ") rejects with HTTP 401', async () => {
      await expect(resolveAuthoritativeSessionMachine({ authHeader: 'Bearer ' }))
        .rejects.toThrow('Bearer token value is missing');
    });

    test('1.6 Whitespace token ("Bearer    ") rejects with HTTP 401', async () => {
      await expect(resolveAuthoritativeSessionMachine({ authHeader: 'Bearer    ' }))
        .rejects.toThrow('Bearer token value is missing');
    });

    test('1.7 Invalid or tampered JWT rejects with HTTP 401', async () => {
      await expect(resolveAuthoritativeSessionMachine({ authHeader: 'Bearer not.a.valid.jwt' }))
        .rejects.toThrow('Invalid, tampered, or expired session token');
    });

    test('1.8 Admin JWT (missing type: "session") rejects with HTTP 401', async () => {
      const adminToken = jwt.sign({ id: 'admin1', role: 'SUPERADMIN' }, process.env.JWT_SECRET);
      await expect(resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${adminToken}` }))
        .rejects.toThrow('Expected session token');
    });

    test('1.9 Session JWT missing sessionId claim rejects with HTTP 401', async () => {
      const badToken = jwt.sign({ type: 'session', machineId: 'm1' }, process.env.JWT_SECRET);
      await expect(resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${badToken}` }))
        .rejects.toThrow('Missing sessionId claim');
    });

    test('1.10 Session not found in DB rejects with HTTP 401', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-notfound', machineId: 'm1' }, process.env.JWT_SECRET);
      prisma.session.findUnique.mockResolvedValue(null);

      await expect(resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${token}` }))
        .rejects.toThrow('Session not found or has been purged');
    });

    test('1.11 Session in terminal COMPLETED status rejects with HTTP 401', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-done', machineId: 'm1' }, process.env.JWT_SECRET);
      prisma.session.findUnique.mockResolvedValue({
        code: 'sess-done',
        status: 'COMPLETED',
        expiresAt: new Date(Date.now() + 600000),
        machineId: 'm1',
        machine: { id: 'm1', status: 'ACTIVE' }
      });

      await expect(resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${token}` }))
        .rejects.toThrow("Session is in terminal state 'COMPLETED'");
    });

    test('1.12 Session in terminal EXPIRED status rejects with HTTP 401', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-exp', machineId: 'm1' }, process.env.JWT_SECRET);
      prisma.session.findUnique.mockResolvedValue({
        code: 'sess-exp',
        status: 'EXPIRED',
        expiresAt: new Date(Date.now() + 600000),
        machineId: 'm1',
        machine: { id: 'm1', status: 'ACTIVE' }
      });

      await expect(resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${token}` }))
        .rejects.toThrow("Session is in terminal state 'EXPIRED'");
    });

    test('1.13 Wall-clock expired session (expiresAt <= now) rejects with HTTP 401', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-old', machineId: 'm1' }, process.env.JWT_SECRET);
      prisma.session.findUnique.mockResolvedValue({
        code: 'sess-old',
        status: 'CONNECTED',
        expiresAt: new Date(Date.now() - 5000), // 5 seconds in past
        machineId: 'm1',
        machine: { id: 'm1', status: 'ACTIVE' }
      });

      await expect(resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${token}` }))
        .rejects.toThrow('Session expired based on TTL');
    });

    test('1.14 Null-safe equality: JWT machineId null, DB machineId populated rejects with HTTP 401', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-mismatch1', machineId: null }, process.env.JWT_SECRET);
      prisma.session.findUnique.mockResolvedValue({
        code: 'sess-mismatch1',
        status: 'CONNECTED',
        expiresAt: new Date(Date.now() + 600000),
        machineId: 'm1',
        machine: { id: 'm1', status: 'ACTIVE' }
      });

      await expect(resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${token}` }))
        .rejects.toThrow('Session machine binding mismatch');
    });

    test('1.15 Null-safe equality: JWT machineId populated, DB machineId null rejects with HTTP 401', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-mismatch2', machineId: 'm1' }, process.env.JWT_SECRET);
      prisma.session.findUnique.mockResolvedValue({
        code: 'sess-mismatch2',
        status: 'CONNECTED',
        expiresAt: new Date(Date.now() + 600000),
        machineId: null,
        machine: null
      });

      await expect(resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${token}` }))
        .rejects.toThrow('Session machine binding mismatch');
    });

    test('1.16 Null-safe equality: JWT machineId does not match DB machineId rejects with HTTP 401', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-mismatch3', machineId: 'machine_A' }, process.env.JWT_SECRET);
      prisma.session.findUnique.mockResolvedValue({
        code: 'sess-mismatch3',
        status: 'CONNECTED',
        expiresAt: new Date(Date.now() + 600000),
        machineId: 'machine_B',
        machine: { id: 'machine_B', status: 'ACTIVE' }
      });

      await expect(resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${token}` }))
        .rejects.toThrow('Session machine binding mismatch');
    });

    test('1.17 Unbound dev session (JWT null === DB null) returns isUnbound: true, machine: null', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-unbound', machineId: null }, process.env.JWT_SECRET);
      prisma.session.findUnique.mockResolvedValue({
        code: 'sess-unbound',
        status: 'CONNECTED',
        expiresAt: new Date(Date.now() + 600000),
        machineId: null,
        machine: null
      });

      const result = await resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${token}` });
      expect(result).toEqual({ isAnonymous: false, isUnbound: true, machine: null });
    });

    test('1.18 Target machine inactive or suspended rejects with HTTP 403', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-inactive', machineId: 'm1' }, process.env.JWT_SECRET);
      prisma.session.findUnique.mockResolvedValue({
        code: 'sess-inactive',
        status: 'CONNECTED',
        expiresAt: new Date(Date.now() + 600000),
        machineId: 'm1',
        machine: { id: 'm1', status: 'MAINTENANCE' }
      });

      await expect(resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${token}` }))
        .rejects.toThrow('Target printer is inactive, suspended, or under maintenance');
    });

    test('1.19 Valid session with WAITING_FOR_MOBILE resolves authoritative machine', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-valid-waiting', machineId: 'm1' }, process.env.JWT_SECRET);
      const mockMachine = { id: 'm1', name: 'Main Kiosk', status: 'ACTIVE', adSuppressionMode: 'ENABLED' };
      prisma.session.findUnique.mockResolvedValue({
        code: 'sess-valid-waiting',
        status: 'WAITING_FOR_MOBILE',
        expiresAt: new Date(Date.now() + 600000),
        machineId: 'm1',
        machine: mockMachine
      });

      const result = await resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${token}` });
      expect(result).toEqual({ isAnonymous: false, isUnbound: false, machine: mockMachine });
    });

    test('1.20 Valid session with CONNECTED resolves authoritative machine', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-valid-connected', machineId: 'm1' }, process.env.JWT_SECRET);
      const mockMachine = { id: 'm1', name: 'Main Kiosk', status: 'ACTIVE', adSuppressionMode: 'ENABLED' };
      prisma.session.findUnique.mockResolvedValue({
        code: 'sess-valid-connected',
        status: 'CONNECTED',
        expiresAt: new Date(Date.now() + 600000),
        machineId: 'm1',
        machine: mockMachine
      });

      const result = await resolveAuthoritativeSessionMachine({ authHeader: `Bearer ${token}` });
      expect(result).toEqual({ isAnonymous: false, isUnbound: false, machine: mockMachine });
    });

    test('1.21 Permanent QR resolution (publicCode) resolves authoritative machine', async () => {
      const mockMachine = { id: 'm_qr', name: 'QR Printer', status: 'ACTIVE', adSuppressionMode: 'ENABLED' };
      prisma.printerQr.findUnique.mockResolvedValue({
        publicCode: 'pq_valid123',
        status: 'ACTIVE',
        machineId: 'm_qr',
        machine: mockMachine
      });

      const result = await resolveAuthoritativeSessionMachine({ publicCode: 'pq_valid123' });
      expect(result).toEqual({ isAnonymous: false, isUnbound: false, machine: mockMachine });
    });

    test('1.22 Inactive / revoked permanent QR rejects with HTTP 403', async () => {
      prisma.printerQr.findUnique.mockResolvedValue({
        publicCode: 'pq_revoked',
        status: 'REVOKED',
        machineId: 'm_qr',
        machine: { id: 'm_qr', status: 'ACTIVE' }
      });

      await expect(resolveAuthoritativeSessionMachine({ publicCode: 'pq_revoked' }))
        .rejects.toThrow('Printer QR is invalid, replaced, or revoked');
    });
  });

  // =========================================================================
  // 2. AD SUPPRESSION SERVICE (adSuppression.service.js)
  // =========================================================================
  describe('2. Ad Suppression & Evaluation Engine', () => {
    test('2.1 Level 1: Machine with PERMANENT suppression returns isSuppressed: true, until: null', () => {
      const machine = { id: 'm1', adSuppressionMode: 'PERMANENT', adSuppressionReason: 'Store request' };
      const res = adSuppressionService.evaluateAdSuppression(machine);
      expect(res.isSuppressed).toBe(true);
      expect(res.until).toBeNull();
      expect(res.reason).toBe('Store request');
    });

    test('2.2 Level 2: Machine with active TEMPORARY suppression returns isSuppressed: true, until: Date', () => {
      const future = new Date(Date.now() + 3600000); // 1h in future
      const machine = { id: 'm1', adSuppressionMode: 'TEMPORARY', adSuppressionUntil: future, adSuppressionReason: 'Meeting' };
      const res = adSuppressionService.evaluateAdSuppression(machine);
      expect(res.isSuppressed).toBe(true);
      expect(res.until).toEqual(future);
    });

    test('2.3 Level 2 Expiry: Machine with expired TEMPORARY suppression returns isSuppressed: false and triggers background atomic expiry', async () => {
      const past = new Date(Date.now() - 3600000); // 1h in past
      const machine = { id: 'm1', adSuppressionMode: 'TEMPORARY', adSuppressionUntil: past };

      prisma.machine.updateMany.mockResolvedValue({ count: 1 });
      prisma.activityLog.create.mockResolvedValue({ id: 'log1' });

      const res = adSuppressionService.evaluateAdSuppression(machine);
      expect(res.isSuppressed).toBe(false);

      // Wait a tick for async trigger
      await new Promise((r) => setImmediate(r));
      expect(prisma.machine.updateMany).toHaveBeenCalledWith({
        where: { id: 'm1', adSuppressionMode: 'TEMPORARY', adSuppressionUntil: past },
        data: { adSuppressionMode: 'ENABLED', adSuppressionUntil: null, adSuppressionReason: null }
      });
    });

    test('2.4 Atomic Expiry: Exactly-once guard writes ActivityLog when updateMany count is 1', async () => {
      const past = new Date('2026-11-13T10:00:00Z');
      prisma.machine.updateMany.mockResolvedValue({ count: 1 });
      prisma.activityLog.create.mockResolvedValue({ id: 'log1' });

      await adSuppressionService.triggerAsyncAtomicExpiry('m_atomic', past);

      expect(prisma.machine.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'AD_SUPPRESSION_EXPIRED',
            machineId: 'm_atomic'
          })
        })
      );
    });

    test('2.5 Atomic Expiry: Concurrency guard skips ActivityLog when another worker already updated it (count: 0)', async () => {
      const past = new Date('2026-11-13T10:00:00Z');
      prisma.machine.updateMany.mockResolvedValue({ count: 0 }); // Already updated

      await adSuppressionService.triggerAsyncAtomicExpiry('m_atomic', past);

      expect(prisma.machine.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.activityLog.create).not.toHaveBeenCalled();
    });

    test('2.6 Ownership: SUPERADMIN can manage any machine', async () => {
      prisma.machine.findUnique.mockResolvedValue({ id: 'm1', companyId: 'comp_other' });
      const user = { id: 'super1', role: 'SUPERADMIN', companyId: 'comp_admin' };

      const res = await adSuppressionService.assertMachineOwnership('m1', user);
      expect(res.id).toBe('m1');
    });

    test('2.7 Ownership: FRANCHISEE can manage own machine', async () => {
      prisma.machine.findUnique.mockResolvedValue({ id: 'm1', companyId: 'comp_own' });
      const user = { id: 'fran1', role: 'FRANCHISEE', companyId: 'comp_own' };

      const res = await adSuppressionService.assertMachineOwnership('m1', user);
      expect(res.id).toBe('m1');
    });

    test('2.8 Ownership: FRANCHISEE cannot manage another company machine (403)', async () => {
      prisma.machine.findUnique.mockResolvedValue({ id: 'm1', companyId: 'comp_different' });
      const user = { id: 'fran1', role: 'FRANCHISEE', companyId: 'comp_own' };

      await expect(adSuppressionService.assertMachineOwnership('m1', user))
        .rejects.toThrow('Access denied: You do not have permission to manage this machine');
    });

    test('2.9 Set suppression: Invalid mode rejects with HTTP 400', async () => {
      prisma.machine.findUnique.mockResolvedValue({ id: 'm1', companyId: 'c1' });
      await expect(adSuppressionService.setAdSuppression('m1', { mode: 'INVALID' }, { role: 'SUPERADMIN' }))
        .rejects.toThrow("Invalid mode: Must be 'PERMANENT' or 'TEMPORARY'");
    });

    test('2.10 Set suppression: TEMPORARY with invalid preset (5 hours) rejects with HTTP 400', async () => {
      prisma.machine.findUnique.mockResolvedValue({ id: 'm1', companyId: 'c1' });
      await expect(adSuppressionService.setAdSuppression('m1', { mode: 'TEMPORARY', durationHours: 5 }, { role: 'SUPERADMIN' }))
        .rejects.toThrow('Invalid durationHours: Must be one of 2, 6, 12, 24');
    });

    test('2.11 Set suppression: TEMPORARY with past customUntil rejects with HTTP 400', async () => {
      prisma.machine.findUnique.mockResolvedValue({ id: 'm1', companyId: 'c1' });
      const past = new Date(Date.now() - 3600000).toISOString();
      await expect(adSuppressionService.setAdSuppression('m1', { mode: 'TEMPORARY', customUntil: past }, { role: 'SUPERADMIN' }))
        .rejects.toThrow('customUntil must be a future date and time');
    });

    test('2.12 Set suppression: Valid TEMPORARY (6 hours) records Machine update, ActivityLog, AuditLog', async () => {
      prisma.machine.findUnique.mockResolvedValue({ id: 'm1', name: 'Kiosk 1', companyId: 'c1', adSuppressionMode: 'ENABLED' });
      prisma.machine.update.mockResolvedValue({
        id: 'm1',
        adSuppressionMode: 'TEMPORARY',
        adSuppressionUntil: new Date(),
        adSuppressionReason: 'Maintenance',
        adSuppressedAt: new Date()
      });
      prisma.activityLog.create.mockResolvedValue({ id: 'act1' });
      prisma.auditLog.create.mockResolvedValue({ id: 'aud1' });

      const res = await adSuppressionService.setAdSuppression(
        'm1',
        { mode: 'TEMPORARY', durationHours: 6, reason: 'Maintenance' },
        { id: 'user1', role: 'SUPERADMIN' },
        '127.0.0.1'
      );

      expect(res.success).toBe(true);
      expect(prisma.machine.update).toHaveBeenCalled();
      expect(prisma.activityLog.create).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    test('2.13 Cancel suppression: Resumes machine to ENABLED and writes logs', async () => {
      prisma.machine.findUnique.mockResolvedValue({
        id: 'm1',
        name: 'Kiosk 1',
        companyId: 'c1',
        adSuppressionMode: 'PERMANENT',
        adSuppressionUntil: null,
        adSuppressionReason: 'Old reason'
      });
      prisma.machine.update.mockResolvedValue({
        id: 'm1',
        adSuppressionMode: 'ENABLED',
        adSuppressionUntil: null,
        adSuppressionReason: null
      });

      const res = await adSuppressionService.cancelAdSuppression('m1', { id: 'u1', role: 'SUPERADMIN' }, '127.0.0.1');
      expect(res.success).toBe(true);
      expect(res.message).toBe('Advertisements resumed successfully');
      expect(prisma.machine.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'm1' },
          data: expect.objectContaining({ adSuppressionMode: 'ENABLED' })
        })
      );
    });
  });

  // =========================================================================
  // 3. ADVERTISEMENT RESOLUTION & PRIORITY (getActiveAdvertisements)
  // =========================================================================
  describe('3. Advertisement Priority & Delivery Engine', () => {
    test('3.1 Anonymous request receives only GLOBAL advertisements, ignoring client query machineId', async () => {
      const req = {
        headers: {},
        query: { machineId: 'attacker_target_machine_id' } // Attempted bypass
      };
      let jsonResult;
      const res = { json: (data) => { jsonResult = data; } };
      const next = jest.fn();

      const globalAd = { id: 'ad_global_1', title: 'Global Brand Ad', scope: 'GLOBAL', placement: 'ALL', isActive: true };
      prisma.advertisement.findMany.mockResolvedValue([globalAd]);

      await adController.getActiveAdvertisements(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(jsonResult.success).toBe(true);
      expect(jsonResult.count).toBe(1);
      expect(jsonResult.advertisements[0].id).toBe('ad_global_1');
      // Verify prisma was called with scope: 'GLOBAL' and NOT with the attacker machineId
      expect(prisma.advertisement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ scope: 'GLOBAL' })
        })
      );
    });

    test('3.2 Bound machine session receives MACHINE_SPECIFIC ads first, then GLOBAL ads', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-prio', machineId: 'm1' }, process.env.JWT_SECRET);
      const req = {
        headers: { authorization: `Bearer ${token}` },
        query: {}
      };
      let jsonResult;
      const res = { json: (data) => { jsonResult = data; } };
      const next = jest.fn();

      prisma.session.findUnique.mockResolvedValue({
        code: 'sess-prio',
        status: 'CONNECTED',
        expiresAt: new Date(Date.now() + 600000),
        machineId: 'm1',
        machine: { id: 'm1', status: 'ACTIVE', adSuppressionMode: 'ENABLED' }
      });

      const machineAd = { id: 'ad_machine_spec', title: 'Store Special', scope: 'MACHINE_SPECIFIC', machineId: 'm1', placement: 'ALL', isActive: true, displayOrder: 0 };
      const globalAd = { id: 'ad_global_spec', title: 'PrintGo Global Promo', scope: 'GLOBAL', machineId: null, placement: 'ALL', isActive: true, displayOrder: 1 };

      // Mock machine-specific ads first, then global ads
      prisma.advertisement.findMany
        .mockResolvedValueOnce([machineAd])
        .mockResolvedValueOnce([globalAd]);

      await adController.getActiveAdvertisements(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(jsonResult.success).toBe(true);
      expect(jsonResult.count).toBe(2);
      expect(jsonResult.advertisements[0].id).toBe('ad_machine_spec');
      expect(jsonResult.advertisements[1].id).toBe('ad_global_spec');
    });

    test('3.3 Suppressed machine returns count: 0 with suppressed: true', async () => {
      const token = jwt.sign({ type: 'session', sessionId: 'sess-suppressed', machineId: 'm_supp' }, process.env.JWT_SECRET);
      const req = {
        headers: { authorization: `Bearer ${token}` },
        query: {}
      };
      let jsonResult;
      const res = { json: (data) => { jsonResult = data; } };
      const next = jest.fn();

      prisma.session.findUnique.mockResolvedValue({
        code: 'sess-suppressed',
        status: 'CONNECTED',
        expiresAt: new Date(Date.now() + 600000),
        machineId: 'm_supp',
        machine: {
          id: 'm_supp',
          status: 'ACTIVE',
          adSuppressionMode: 'PERMANENT',
          adSuppressionReason: 'Store quiet hours'
        }
      });

      await adController.getActiveAdvertisements(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(jsonResult.count).toBe(0);
      expect(jsonResult.suppressed).toBe(true);
      expect(jsonResult.reason).toBe('Store quiet hours');
    });

    test('3.4 Placement filter KIOSK filters ads for KIOSK_ONLY or ALL', async () => {
      const req = {
        headers: {},
        query: { placement: 'KIOSK_ONLY' }
      };
      let jsonResult;
      const res = { json: (data) => { jsonResult = data; } };
      const next = jest.fn();

      prisma.advertisement.findMany.mockResolvedValue([]);

      await adController.getActiveAdvertisements(req, res, next);

      expect(prisma.advertisement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                placement: { in: ['KIOSK_ONLY', 'ALL'] }
              })
            ])
          })
        })
      );
    });
  });

  // =========================================================================
  // 4. ADVERTISEMENT CRUD SCOPE & PERMISSIONS VALIDATION
  // =========================================================================
  describe('4. Advertisement CRUD Scope Validation', () => {
    test('4.1 GLOBAL advertisement with machineId rejects with HTTP 400', async () => {
      const req = {
        user: { role: 'SUPERADMIN', companyId: 'c1' },
        body: {
          title: 'Invalid Global Ad',
          scope: 'GLOBAL',
          machineId: 'm1',
          type: 'IMAGE'
        },
        file: { filename: 'test.jpg' }
      };
      const res = {};
      const next = jest.fn();

      await adController.createAdvertisement(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'GLOBAL advertisements cannot be bound to a specific machineId',
          statusCode: 400
        })
      );
    });

    test('4.2 MACHINE_SPECIFIC advertisement without machineId rejects with HTTP 400', async () => {
      const req = {
        user: { role: 'SUPERADMIN', companyId: 'c1' },
        body: {
          title: 'Invalid Machine Ad',
          scope: 'MACHINE_SPECIFIC',
          type: 'IMAGE'
        },
        file: { filename: 'test.jpg' }
      };
      const res = {};
      const next = jest.fn();

      await adController.createAdvertisement(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'MACHINE_SPECIFIC advertisements require a valid machineId',
          statusCode: 400
        })
      );
    });

    test('4.3 FRANCHISEE cannot create GLOBAL advertisements (403)', async () => {
      const req = {
        user: { role: 'FRANCHISEE', companyId: 'c1' },
        body: {
          title: 'Franchisee Global Attempt',
          scope: 'GLOBAL',
          type: 'IMAGE'
        },
        file: { filename: 'test.jpg' }
      };
      const res = {};
      const next = jest.fn();

      await adController.createAdvertisement(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Only SUPERADMIN can create GLOBAL advertisements',
          statusCode: 403
        })
      );
    });

    test('4.4 FRANCHISEE cannot create MACHINE_SPECIFIC ad targeting another company machine (403)', async () => {
      prisma.machine.findUnique.mockResolvedValue({ id: 'm_foreign', companyId: 'comp_other' });

      const req = {
        user: { role: 'FRANCHISEE', companyId: 'comp_my' },
        body: {
          title: 'Foreign Ad',
          scope: 'MACHINE_SPECIFIC',
          machineId: 'm_foreign',
          type: 'IMAGE'
        },
        file: { filename: 'test.jpg' }
      };
      const res = {};
      const next = jest.fn();

      await adController.createAdvertisement(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Access denied: You do not own the specified machine',
          statusCode: 403
        })
      );
    });
  });

  // =========================================================================
  // 5. MACHINE AD SUPPRESSION CONTROLLER & STATUS API
  // =========================================================================
  describe('5. Machine Ad Suppression Controller Handlers', () => {
    const machinesController = require('../src/modules/machines/machines.controller');

    test('5.1 machinesController.setAdSuppression delegates to adSuppressionService', async () => {
      prisma.machine.findUnique.mockResolvedValue({ id: 'm_ctrl', name: 'Kiosk', companyId: 'c1', adSuppressionMode: 'ENABLED' });
      prisma.machine.update.mockResolvedValue({
        id: 'm_ctrl',
        adSuppressionMode: 'PERMANENT',
        adSuppressionUntil: null,
        adSuppressionReason: 'Test',
        adSuppressedAt: new Date()
      });
      prisma.activityLog.create.mockResolvedValue({ id: 'log1' });
      prisma.auditLog.create.mockResolvedValue({ id: 'aud1' });

      const req = {
        params: { id: 'm_ctrl' },
        body: { mode: 'PERMANENT', reason: 'Test' },
        user: { id: 'u1', role: 'SUPERADMIN' },
        ip: '127.0.0.1'
      };
      let jsonResult;
      const res = { json: (data) => { jsonResult = data; } };
      const next = jest.fn();

      await machinesController.setAdSuppression(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(jsonResult.success).toBe(true);
      expect(jsonResult.adSuppressionMode).toBe('PERMANENT');
    });

    test('5.2 machinesController.cancelAdSuppression delegates to adSuppressionService', async () => {
      prisma.machine.findUnique.mockResolvedValue({
        id: 'm_ctrl',
        name: 'Kiosk',
        companyId: 'c1',
        adSuppressionMode: 'PERMANENT',
        adSuppressionUntil: null
      });
      prisma.machine.update.mockResolvedValue({
        id: 'm_ctrl',
        adSuppressionMode: 'ENABLED',
        adSuppressionUntil: null,
        adSuppressionReason: null
      });
      prisma.activityLog.create.mockResolvedValue({ id: 'log1' });
      prisma.auditLog.create.mockResolvedValue({ id: 'aud1' });

      const req = {
        params: { id: 'm_ctrl' },
        user: { id: 'u1', role: 'SUPERADMIN' },
        ip: '127.0.0.1'
      };
      let jsonResult;
      const res = { json: (data) => { jsonResult = data; } };
      const next = jest.fn();

      await machinesController.cancelAdSuppression(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(jsonResult.success).toBe(true);
      expect(jsonResult.message).toBe('Advertisements resumed successfully');
    });

    test('5.3 machinesController.getAdSuppressionStatus returns accurate status and remaining time', async () => {
      const future = new Date(Date.now() + 7200000); // 2 hours
      prisma.machine.findUnique.mockResolvedValue({
        id: 'm_ctrl',
        name: 'Kiosk',
        companyId: 'c1',
        adSuppressionMode: 'TEMPORARY',
        adSuppressionUntil: future,
        adSuppressionReason: 'Store request',
        adSuppressedAt: new Date()
      });

      const req = {
        params: { id: 'm_ctrl' },
        user: { id: 'u1', role: 'SUPERADMIN' }
      };
      let jsonResult;
      const res = { json: (data) => { jsonResult = data; } };
      const next = jest.fn();

      await machinesController.getAdSuppressionStatus(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(jsonResult.success).toBe(true);
      expect(jsonResult.adSuppressionMode).toBe('TEMPORARY');
      expect(jsonResult.isSuppressed).toBe(true);
      expect(jsonResult.remainingSeconds).toBeGreaterThan(7000);
      expect(jsonResult.adSuppressionReason).toBe('Store request');
    });
  });
});
