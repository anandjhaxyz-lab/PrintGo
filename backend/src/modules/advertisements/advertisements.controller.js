const fs = require('fs');
const path = require('path');
const prisma = require('../../utils/prisma');
const logger = require('../../utils/logger');
const AppError = require('../../utils/AppError');

/**
 * Public: Get active, non-expired advertisements for customer portal
 */
const getActiveAdvertisements = async (req, res, next) => {
  try {
    const now = new Date();
    const advertisements = await prisma.advertisement.findMany({
      where: {
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
          }
        ]
      },
      orderBy: [
        { displayOrder: 'asc' },
        { createdAt: 'desc' }
      ],
      select: {
        id: true,
        title: true,
        type: true,
        mediaUrl: true,
        thumbnailUrl: true,
        displayDuration: true,
        displayOrder: true
      }
    });

    res.json({
      success: true,
      count: advertisements.length,
      advertisements
    });
  } catch (err) {
    logger.error('Failed to fetch active advertisements:', err);
    next(err);
  }
};

/**
 * Admin: Get all advertisements with full metadata
 */
const getAllAdvertisements = async (req, res, next) => {
  try {
    const advertisements = await prisma.advertisement.findMany({
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
 * Admin: Create advertisement with uploaded image or video
 */
const createAdvertisement = async (req, res, next) => {
  try {
    const { title, displayDuration, displayOrder, startDate, endDate, isActive } = req.body;

    if (!title || !title.trim()) {
      return next(new AppError('Advertisement title is required', 400));
    }

    if (!req.file) {
      return next(new AppError('Advertisement media file (photo or video) is required', 400));
    }

    const mime = req.file.mimetype || '';
    const isVideo = mime.startsWith('video/');
    const type = isVideo ? 'VIDEO' : 'IMAGE';
    const mediaUrl = `/uploads/ads/${req.file.filename}`;

    const ad = await prisma.advertisement.create({
      data: {
        title: title.trim(),
        type,
        mediaUrl,
        displayDuration: displayDuration ? parseInt(displayDuration, 10) : 5,
        displayOrder: displayOrder ? parseInt(displayOrder, 10) : 0,
        isActive: isActive !== undefined ? (isActive === 'true' || isActive === true) : true,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        fileSize: req.file.size,
        mimeType: mime,
        createdBy: req.user?.id || null,
        companyId: req.user?.companyId || null
      }
    });

    logger.info(`Advertisement created: ${ad.title} (${ad.type}) by user ${req.user?.id}`);

    res.status(201).json({
      success: true,
      advertisement: ad
    });
  } catch (err) {
    logger.error('Failed to create advertisement:', err);
    // Cleanup uploaded file on error
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
 * Admin: Update advertisement metadata or replace media
 */
const updateAdvertisement = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, displayDuration, displayOrder, startDate, endDate, isActive } = req.body;

    const existing = await prisma.advertisement.findUnique({ where: { id } });
    if (!existing) {
      return next(new AppError('Advertisement not found', 404));
    }

    const updateData = {};

    if (title !== undefined) updateData.title = title.trim();
    if (displayDuration !== undefined) updateData.displayDuration = parseInt(displayDuration, 10);
    if (displayOrder !== undefined) updateData.displayOrder = parseInt(displayOrder, 10);
    if (isActive !== undefined) updateData.isActive = isActive === 'true' || isActive === true;
    if (startDate !== undefined) updateData.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) updateData.endDate = endDate ? new Date(endDate) : null;

    // If new file uploaded, update media and remove old file
    if (req.file) {
      const mime = req.file.mimetype || '';
      updateData.type = mime.startsWith('video/') ? 'VIDEO' : 'IMAGE';
      updateData.mediaUrl = `/uploads/ads/${req.file.filename}`;
      updateData.fileSize = req.file.size;
      updateData.mimeType = mime;

      // Clean up previous file if local
      if (existing.mediaUrl && existing.mediaUrl.startsWith('/uploads/ads/')) {
        const oldPath = path.join(__dirname, '../../../uploads/ads', path.basename(existing.mediaUrl));
        if (fs.existsSync(oldPath)) {
          try {
            fs.unlinkSync(oldPath);
          } catch (e) {
            logger.warn('Could not remove old ad file:', e.message);
          }
        }
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
    next(err);
  }
};

/**
 * Admin: Toggle active state
 */
const toggleActive = async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.advertisement.findUnique({ where: { id } });
    if (!existing) {
      return next(new AppError('Advertisement not found', 404));
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
 * Admin: Reorder advertisements
 */
const reorderAdvertisements = async (req, res, next) => {
  try {
    const { items } = req.body; // Array of { id, displayOrder } or Array of ids
    if (!Array.isArray(items)) {
      return next(new AppError('Items array is required for reordering', 400));
    }

    const updates = items.map((item, index) => {
      const id = typeof item === 'string' ? item : item.id;
      const displayOrder = typeof item === 'object' && item.displayOrder !== undefined ? item.displayOrder : index;
      return prisma.advertisement.update({
        where: { id },
        data: { displayOrder }
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
 * Admin: Delete advertisement and clean up media file
 */
const deleteAdvertisement = async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.advertisement.findUnique({ where: { id } });
    if (!existing) {
      return next(new AppError('Advertisement not found', 404));
    }

    await prisma.advertisement.delete({ where: { id } });

    // Clean up media file from disk
    if (existing.mediaUrl && existing.mediaUrl.startsWith('/uploads/ads/')) {
      const filePath = path.join(__dirname, '../../../uploads/ads', path.basename(existing.mediaUrl));
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          logger.warn('Could not remove ad file on deletion:', e.message);
        }
      }
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
