const prisma = require('../../utils/prisma');
const printerDiscoveryService = require('../../services/printerDiscovery.service');
const printerQrService = require('../../services/printerQr.service');
const printerDeviceAdminService = require('../../services/printerDeviceAdmin.service');

const listPrinterDiscoveries = async (req, res, next) => {
  try {
    const result = await printerDiscoveryService.listPrinterDiscoveries(req.user, req.query, prisma);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

const listApprovedPrinterDevices = async (req, res, next) => {
  try {
    const result = await printerDiscoveryService.listApprovedPrinterDevices(req.user, req.query, prisma);
    const devices = result.devices.map((device) => ({
      ...device,
      activeQr: device.activeQr
        ? { ...device.activeQr, targetUrl: printerQrService.getPublicQrUrl(device.activeQr.publicCode) }
        : null
    }));
    res.status(200).json({
      success: true,
      data: {
        ...result,
        devices,
        deviceQrEnabled: process.env.ENABLE_MULTI_PRINTER_DISPATCH === 'true'
      }
    });
  } catch (error) {
    next(error);
  }
};

const approvePrinterDiscovery = async (req, res, next) => {
  try {
    const isStagingApprovalsEnabled = process.env.STAGING_PRINTER_APPROVALS_ENABLED === 'true' ||
                                     process.env.ALLOW_STAGING_PRINTER_APPROVALS === 'true';
    if (isStagingApprovalsEnabled && req.body?.isDefault !== false) {
      return res.status(400).json({
        success: false,
        error: 'Approval request must explicitly contain isDefault: false.'
      });
    }

    const result = await printerDiscoveryService.approvePrinterDiscovery(
      req.params.id, req.body || {}, req.user, prisma
    );
    res.status(result.alreadyApproved ? 200 : 201).json({
      success: true,
      message: result.alreadyApproved ? 'Printer was already approved.' : 'Printer approved and registered successfully.',
      data: { device: result.device, alreadyApproved: result.alreadyApproved }
    });
  } catch (error) {
    next(error);
  }
};

const disablePrinterDevice = async (req, res, next) => {
  try {
    const result = await printerDeviceAdminService.disablePrinterDevice(
      req.params.id, req.body || {}, req.user, prisma
    );
    res.status(200).json({
      success: true,
      message: result.alreadyDisabled ? 'Printer device is already disabled.' : 'Printer device disabled successfully.',
      data: result
    });
  } catch (error) {
    next(error);
  }
};

const enablePrinterDevice = async (req, res, next) => {
  try {
    const result = await printerDeviceAdminService.enablePrinterDevice(
      req.params.id, req.body || {}, req.user, prisma
    );
    res.status(200).json({
      success: true,
      message: result.alreadyEnabled ? 'Printer device is already active.' : 'Printer device enabled successfully.',
      data: result
    });
  } catch (error) {
    next(error);
  }
};

const remapPrinterDevice = async (req, res, next) => {
  try {
    const result = await printerDeviceAdminService.remapPrinterDevice(
      req.params.id, req.body || {}, req.user, prisma
    );
    res.status(200).json({
      success: true,
      message: 'Printer device mapping updated successfully.',
      data: result
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { listPrinterDiscoveries, listApprovedPrinterDevices, approvePrinterDiscovery, disablePrinterDevice, enablePrinterDevice, remapPrinterDevice };
