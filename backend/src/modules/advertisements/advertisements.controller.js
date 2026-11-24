const fs = require('fs');
const path = require('path');
const prisma = require('../../utils/prisma');
const logger = require('../../utils/logger');
const AppError = require('../../utils/AppError');
const { getAdsUploadsDir } = require('../../utils/storage');
const { resolveAuthoritativeSessionMachine } = require('../../services/sessionSecurity.service');
const { evaluateAdSuppression } = require('../../services/adSuppression.service');

const VALID_SCOPES = new Set(['GLOBAL', 'MACHINE_SPECIFIC']);
const VALID_PLACEMENTS = new Set(['ALL', 'KIOSK_ONLY', 'MOBILE_ONLY']);

/**
 * Validates external media URL: must be valid HTTPS and safe against SSRF.
 * @param {string} urlStr
 * @returns {{ isValid: boolean, error?: string, parsedUrl?: URL }}
 */
const validateExternalMediaUrl = (urlStr) => {
  if (!urlStr || typeof urlStr !== 'string') {
    return { isValid: false, error: 'Media URL is required' };
  }
  const trimmed = urlStr.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    return { isValid: false, error: 'Invalid media URL format' };
  }

  if (parsed.protocol !== 'https:') {
    return { isValid: false, error: 'External media URL must use https:// protocol' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // SSRF Protection: Deny localhost, private IPs, loopback, link-local, cloud metadata
  const blockedHostnames = ['localhost', 'metadata.google.internal'];
  if (blockedHostnames.includes(hostname)) {
    return { isValid: false, error: 'External media URL host is not permitted' };
  }

  // Check IPv4 private and link-local ranges
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = hostname.match(ipv4Regex);
  if (match) {
    const [, a, b] = match.map(Number);
    if (
      a === 127 || // Loopback
      a === 10 ||  // Private class A
      a === 0 ||   // Zero network
      (a === 172 && b >= 16 && b <= 31) || // Private class B
      (a === 192 && b === 168) || // Private class C
      (a === 169 && b === 254)    // Link-local / AWS / Cloud metadata
    ) {
      return { isValid: false, error: 'External media URL host is not permitted (private network / link-local address)' };
    }
  }

  // IPv6 loopback / unique local addresses
  if (hostname === '[::1]' || hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')) {
    return { isValid: false, error: 'External media URL host is not permitted' };
  }

  return { isValid: true, parsedUrl: parsed };
};

/**
 * Safely deletes local media file from disk only if no other advertisement references it.
 * Ensures path stays within adsUploadsDir to prevent path traversal.
 * Never deletes external URLs.
 * @param {string} mediaUrl
 * @param {string} excludeAdId
 */
const safeDeleteMediaFile = async (mediaUrl, excludeAdId) => {
  if (!mediaUrl || typeof mediaUrl !== 'string' || mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) {
    return;
  }

  try {
    const sharedCount = await prisma.advertisement.count({
      where: {
        mediaUrl: mediaUrl,
        ...(excludeAdId ? { id: { not: excludeAdId } } : {})
      }
    });

    if (sharedCount > 0) {
      logger.info(`Media file ${mediaUrl} retained; referenced by ${sharedCount} other advertisement(s).`);
      return;
    }

    const filename = path.basename(mediaUrl);
    const adsDir = path.resolve(getAdsUploadsDir());
    const filePath = path.resolve(adsDir, filename);

    // Path traversal prevention check
    if (!filePath.startsWith(adsDir)) {
      logger.warn(`Suspicious media path traversal attempt blocked: ${mediaUrl}`);
      return;
    }

    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        logger.info(`Successfully deleted unreferenced advertisement media: ${filename}`);
      } catch (err) {
        logger.warn(`Failed to unlink advertisement media ${filePath}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error('Error during safe media file cleanup:', err);
  }
};

/**
 * Public: Get active advertisements respecting Level 1 -> Level 5 priority hierarchy.
 *
 * Query parameters:
 * - publicCode: (Optional) From permanent printer flyer QR (/p/:publicCode)
 * - placement: (Optional) 'KIOSK_ONLY' | 'MOBILE_ONLY' | 'ALL'
 *
 * NOTE: Any client query parameter `machineId` is completely ignored for security.
 */
const getActiveAdvertisements = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const publicCode = req.query.publicCode;
    const requestedPlacement = req.query.placement ? String(req.query.placement).toUpperCase().trim() : null;

    // 1. Resolve Authoritative Identity (Fails closed on any invalid token or format)
    const { isAnonymous, isUnbound, machine } = await resolveAuthoritativeSessionMachine({
      authHeader,
      publicCode
    });

    // 2. Evaluate Suppression Hierarchy (Level 1 & Level 2)
    if (machine) {
      const suppression = evaluateAdSuppression(machine);
      if (suppression.isSuppressed) {
        return res.json({
          success: true,
          count: 0,
          advertisements: [],
          suppressed: true,
          reason: suppression.reason
        });
      }
    }

    // 3. Build Base Active & Schedule Filter (Level 3)
    const now = new Date();
    const placementFilter = requestedPlacement && VALID_PLACEMENTS.has(requestedPlacement)
      ? { placement: { in: [requestedPlacement, 'ALL'] } }
      : {};

    const baseWhere = {
      isActive: true,
      AND: [
        {
          OR: [
            { startDate: null },
            { startDate: { lte: now } }
          ]
        },
        {
          OR: [
            { endDate: null },
            { endDate: { gte: now } }
          ]
        },
        placementFilter
      ]
    };

    // 4. Resolve Advertisements by Priority Scope (Level 4 & Level 5)
    let advertisements = [];

    if (machine && machine.id) {
      // Fetch machine-specific ads (Level 4) and global ads (Level 5) in parallel
      const [machineAds, globalAds] = await Promise.all([
        prisma.advertisement.findMany({
          where: {
            ...baseWhere,
            scope: 'MACHINE_SPECIFIC',
            machineId: machine.id
          },
          orderBy: [
            { displayOrder: 'asc' },
            { createdAt: 'desc' }
          ]
        }),
        prisma.advertisement.findMany({
          where: {
            ...baseWhere,
            scope: 'GLOBAL'
          },
          orderBy: [
            { displayOrder: 'asc' },
            { createdAt: 'desc' }
          ]
        })
      ]);

      // Strict Priority Ordering: Machine-specific ads come first, followed by global ads
      advertisements = [...machineAds, ...globalAds];
    } else {
      // Anonymous or Unbound dev sessions receive strictly GLOBAL ads
      advertisements = await prisma.advertisement.findMany({
        where: {
          ...baseWhere,
          scope: 'GLOBAL'
        },
        orderBy: [
          { displayOrder: 'asc' },
          { createdAt: 'desc' }
        ]
      });
    }

    // Sanitize response to safe presentation fields
    const sanitizedAds = advertisements.map((ad) => ({
      id: ad.id,
      title: ad.title,
      type: ad.type,
      mediaUrl: ad.mediaUrl,
      thumbnailUrl: ad.thumbnailUrl,
      displayDuration: ad.displayDuration,
      displayOrder: ad.displayOrder,
      scope: ad.scope,
      placement: ad.placement,
      machineId: ad.machineId || null
    }));

    res.json({
      success: true,
      count: sanitizedAds.length,
      advertisements: sanitizedAds,
      scopeContext: machine ? 'MACHINE_BOUND' : (isUnbound ? 'UNBOUND_DEV' : 'ANONYMOUS_GLOBAL')
    });
  } catch (err) {
    if (err instanceof AppError) {
      return next(err);
    }
    logger.error('Failed to fetch active advertisements:', err);
    next(err);
  }
};

/**
 * Admin: Get all advertisements with full metadata and machine filter.
 */
const getAllAdvertisements = async (req, res, next) => {
  try {
    const { machineId, scope } = req.query;
    const where = {};

    // Franchisee scoping: non-superadmin users only see ads for their company or global ads
    if (req.user && req.user.role !== 'SUPERADMIN') {
      where.OR = [
        { scope: 'GLOBAL' },
        { companyId: req.user.companyId }
      ];
    }

    if (machineId) where.machineId = String(machineId).trim();
    if (scope && VALID_SCOPES.has(scope.toUpperCase())) where.scope = scope.toUpperCase();

    const advertisements = await prisma.advertisement.findMany({
      where,
      include: {
        machine: {
          select: { id: true, name: true, location: true }
        }
      },
      orderBy: [
        { displayOrder: 'asc' },
        { createdAt: 'desc' }
      ]
    });

    res.json({
      success: true,
      count: advertisements.length,
      advertisements
    });
  } catch (err) {
    logger.error('Failed to fetch all advertisements:', err);
    next(err);
  }
};

/**
 * Admin: Create advertisement with strict scope and machine validation.
 */
const createAdvertisement = async (req, res, next) => {
  try {
    const {
      title,
      displayDuration,
      displayOrder,
      startDate,
      endDate,
      isActive,
      scope: rawScope,
      placement: rawPlacement,
      machineId
    } = req.body;

    if (!title || !title.trim()) {
      return next(new AppError('Advertisement title is required', 400));
    }

    let mediaUrl;
    let type;
    let fileSize = null;
    let mimeType = null;

    if (req.file) {
      const mime = req.file.mimetype || '';
      const isVideo = mime.startsWith('video/');
      type = isVideo ? 'VIDEO' : 'IMAGE';
      mediaUrl = `/uploads/ads/${req.file.filename}`;
      fileSize = req.file.size;
      mimeType = mime;
    } else if (req.body.mediaUrl) {
      const urlCheck = validateExternalMediaUrl(req.body.mediaUrl);
      if (!urlCheck.isValid) {
        return next(new AppError(urlCheck.error, 400));
      }
      mediaUrl = req.body.mediaUrl.trim();
      const rawType = req.body.type ? String(req.body.type).toUpperCase().trim() : null;
      if (rawType && (rawType === 'VIDEO' || rawType === 'IMAGE')) {
        type = rawType;
      } else {
        const ext = path.extname(urlCheck.parsedUrl.pathname).toLowerCase();
        type = (ext === '.mp4' || ext === '.webm' || ext === '.ogg') ? 'VIDEO' : 'IMAGE';
      }
      mimeType = type === 'VIDEO' ? 'video/mp4' : 'image/jpeg';
    } else {
      return next(new AppError('Advertisement media file or external HTTPS media URL is required', 400));
    }

    // Scope Validation Invariant
    const scope = rawScope ? String(rawScope).toUpperCase().trim() : 'GLOBAL';
    if (!VALID_SCOPES.has(scope)) {
      return next(new AppError("Invalid scope: Must be 'GLOBAL' or 'MACHINE_SPECIFIC'", 400));
    }

    let resolvedMachineId = null;
    let targetCompanyId = req.user?.companyId || null;

    if (scope === 'GLOBAL') {
      if (req.user && req.user.role !== 'SUPERADMIN') {
        return next(new AppError('Only SUPERADMIN can create GLOBAL advertisements', 403));
      }
      if (machineId) {
        return next(new AppError('GLOBAL advertisements cannot be bound to a specific machineId', 400));
      }
    } else if (scope === 'MACHINE_SPECIFIC') {
      if (!machineId || typeof machineId !== 'string' || !machineId.trim()) {
        return next(new AppError('MACHINE_SPECIFIC advertisements require a valid machineId', 400));
      }
      resolvedMachineId = machineId.trim();

      // Verify machine exists and check ownership
      const machine = await prisma.machine.findUnique({
        where: { id: resolvedMachineId },
        select: { id: true, companyId: true, name: true }
      });

      if (!machine) {
        return next(new AppError('Specified machine does not exist', 404));
      }

      if (req.user && req.user.role !== 'SUPERADMIN' && machine.companyId !== req.user.companyId) {
        return next(new AppError('Access denied: You do not own the specified machine', 403));
      }

      if (machine.companyId) {
        targetCompanyId = machine.companyId;
      }
    }

    // Placement Validation Invariant
    const placement = rawPlacement ? String(rawPlacement).toUpperCase().trim() : 'ALL';
    if (!VALID_PLACEMENTS.has(placement)) {
      return next(new AppError("Invalid placement: Must be 'ALL', 'KIOSK_ONLY', or 'MOBILE_ONLY'", 400));
    }

    const ad = await prisma.advertisement.create({
      data: {
        title: title.trim(),
        type,
        mediaUrl,
        displayDuration: displayDuration ? parseInt(displayDuration, 10) : 5,
        displayOrder: displayOrder ? parseInt(displayOrder, 10) : 0,
        isActive: isActive !== undefined ? (isActive === 'true' || isActive === true) : true,
        scope,
        placement,
        machineId: resolvedMachineId,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        fileSize,
        mimeType,
        createdBy: req.user?.id || null,
        companyId: targetCompanyId
      }
    });

    logger.info(`Advertisement created: ${ad.title} (${ad.type}, scope=${ad.scope}) by user ${req.user?.id}`);

    res.status(201).json({
      success: true,
      advertisement: ad
    });
  } catch (err) {
    logger.error('Failed to create advertisement:', err);
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupErr) {
        logger.warn('Failed to cleanup file after error:', cleanupErr.message);
      }
    }
    next(err);
  }
};

/**
 * Admin: Update advertisement metadata or replace media.
 */
const updateAdvertisement = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      title,
      displayDuration,
      displayOrder,
      startDate,
      endDate,
      isActive,
      scope: rawScope,
      placement: rawPlacement,
      machineId
    } = req.body;

    const existing = await prisma.advertisement.findUnique({ where: { id } });
    if (!existing) {
      return next(new AppError('Advertisement not found', 404));
    }

    // Role Ownership Guard
    if (req.user && req.user.role !== 'SUPERADMIN') {
      if (existing.scope === 'GLOBAL') {
        return next(new AppError('Forbidden: Only SUPERADMIN can modify GLOBAL advertisements', 403));
      }
      if (existing.companyId && existing.companyId !== req.user.companyId) {
        return next(new AppError('Forbidden: You do not have permission to modify this advertisement', 403));
      }
    }

    const updateData = {};

    if (title !== undefined) updateData.title = title.trim();
    if (displayDuration !== undefined) updateData.displayDuration = parseInt(displayDuration, 10);
    if (displayOrder !== undefined) updateData.displayOrder = parseInt(displayOrder, 10);
    if (isActive !== undefined) updateData.isActive = isActive === 'true' || isActive === true;
    if (startDate !== undefined) updateData.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) updateData.endDate = endDate ? new Date(endDate) : null;

    // Scope & Machine Updates
    const targetScope = rawScope ? String(rawScope).toUpperCase().trim() : existing.scope;
    if (rawScope !== undefined && !VALID_SCOPES.has(targetScope)) {
      return next(new AppError("Invalid scope: Must be 'GLOBAL' or 'MACHINE_SPECIFIC'", 400));
    }
    updateData.scope = targetScope;

    if (targetScope === 'GLOBAL') {
      updateData.machineId = null;
    } else if (targetScope === 'MACHINE_SPECIFIC') {
      const targetMachineId = machineId !== undefined ? (machineId ? String(machineId).trim() : null) : existing.machineId;
      if (!targetMachineId) {
        return next(new AppError('MACHINE_SPECIFIC advertisements require a valid machineId', 400));
      }

      const machine = await prisma.machine.findUnique({
        where: { id: targetMachineId },
        select: { id: true, companyId: true }
      });

      if (!machine) {
        return next(new AppError('Specified machine does not exist', 404));
      }

      if (req.user && req.user.role !== 'SUPERADMIN' && machine.companyId !== req.user.companyId) {
        return next(new AppError('Access denied: You do not own the specified machine', 403));
      }

      updateData.machineId = targetMachineId;
      if (machine.companyId) updateData.companyId = machine.companyId;
    }

    if (rawPlacement !== undefined) {
      const placement = String(rawPlacement).toUpperCase().trim();
      if (!VALID_PLACEMENTS.has(placement)) {
        return next(new AppError("Invalid placement: Must be 'ALL', 'KIOSK_ONLY', or 'MOBILE_ONLY'", 400));
      }
      updateData.placement = placement;
    }

    // If new file uploaded or new external mediaUrl provided, update media
    if (req.file) {
      const mime = req.file.mimetype || '';
      const isVideo = mime.startsWith('video/');
      updateData.type = isVideo ? 'VIDEO' : 'IMAGE';
      updateData.mediaUrl = `/uploads/ads/${req.file.filename}`;
      updateData.fileSize = req.file.size;
      updateData.mimeType = mime;

      if (existing.mediaUrl && existing.mediaUrl !== updateData.mediaUrl) {
        await safeDeleteMediaFile(existing.mediaUrl, existing.id);
      }
    } else if (req.body.mediaUrl !== undefined) {
      const urlCheck = validateExternalMediaUrl(req.body.mediaUrl);
      if (!urlCheck.isValid) {
        return next(new AppError(urlCheck.error, 400));
      }
      const newMediaUrl = req.body.mediaUrl.trim();
      updateData.mediaUrl = newMediaUrl;
      const rawType = req.body.type ? String(req.body.type).toUpperCase().trim() : null;
      if (rawType && (rawType === 'VIDEO' || rawType === 'IMAGE')) {
        updateData.type = rawType;
      } else {
        const ext = path.extname(urlCheck.parsedUrl.pathname).toLowerCase();
        updateData.type = (ext === '.mp4' || ext === '.webm' || ext === '.ogg') ? 'VIDEO' : 'IMAGE';
      }
      updateData.mimeType = updateData.type === 'VIDEO' ? 'video/mp4' : 'image/jpeg';
      updateData.fileSize = null;

      if (existing.mediaUrl && existing.mediaUrl !== newMediaUrl) {
        await safeDeleteMediaFile(existing.mediaUrl, existing.id);
      }
    }

    const updated = await prisma.advertisement.update({
      where: { id },
      data: updateData
    });

    res.json({
      success: true,
      advertisement: updated
    });
  } catch (err) {
    logger.error('Failed to update advertisement:', err);
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupErr) {
        logger.warn('Failed to cleanup file after error:', cleanupErr.message);
      }
    }
    next(err);
  }
};

/**
 * Admin: Toggle advertisement active status.
 */
const toggleActive = async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.advertisement.findUnique({ where: { id } });
    if (!existing) {
      return next(new AppError('Advertisement not found', 404));
    }

    if (req.user && req.user.role !== 'SUPERADMIN' && existing.scope === 'GLOBAL') {
      return next(new AppError('Forbidden: Only SUPERADMIN can toggle GLOBAL advertisements', 403));
    }

    const updated = await prisma.advertisement.update({
      where: { id },
      data: { isActive: !existing.isActive }
    });

    res.json({
      success: true,
      advertisement: updated
    });
  } catch (err) {
    logger.error('Failed to toggle advertisement status:', err);
    next(err);
  }
};

/**
 * Admin: Reorder advertisements.
 */
const reorderAdvertisements = async (req, res, next) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return next(new AppError('Items array required', 400));
    }

    const updates = items.map((item, idx) => {
      const id = typeof item === 'string' ? item : item.id;
      return prisma.advertisement.update({
        where: { id },
        data: { displayOrder: idx }
      });
    });

    await prisma.$transaction(updates);

    res.json({
      success: true,
      message: 'Advertisements reordered successfully'
    });
  } catch (err) {
    logger.error('Failed to reorder advertisements:', err);
    next(err);
  }
};

/**
 * Admin: Delete advertisement and clean up media file.
 */
const deleteAdvertisement = async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.advertisement.findUnique({ where: { id } });
    if (!existing) {
      return next(new AppError('Advertisement not found', 404));
    }

    if (req.user && req.user.role !== 'SUPERADMIN') {
      if (existing.scope === 'GLOBAL') {
        return next(new AppError('Forbidden: Only SUPERADMIN can delete GLOBAL advertisements', 403));
      }
      if (existing.companyId && existing.companyId !== req.user.companyId) {
        return next(new AppError('Forbidden: You do not have permission to delete this advertisement', 403));
      }
    }

    await prisma.advertisement.delete({ where: { id } });

    if (existing.mediaUrl) {
      await safeDeleteMediaFile(existing.mediaUrl, existing.id);
    }

    res.json({
      success: true,
      message: 'Advertisement deleted successfully'
    });
  } catch (err) {
    logger.error('Failed to delete advertisement:', err);
    next(err);
  }
};

module.exports = {
  getActiveAdvertisements,
  getAllAdvertisements,
  createAdvertisement,
  updateAdvertisement,
  toggleActive,
  reorderAdvertisements,
  deleteAdvertisement
};
