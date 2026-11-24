const printerQrService = require('../../services/printerQr.service');

const listPrinterQrs = async (req, res, next) => {
  try {
    const result = await printerQrService.listPrinterQrs(req.user, req.query);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

const getPrinterQrById = async (req, res, next) => {
  try {
    const qr = await printerQrService.getPrinterQrById(req.params.id, req.user);
    res.status(200).json({ success: true, data: { qr } });
  } catch (error) {
    next(error);
  }
};

const generatePrinterQr = async (req, res, next) => {
  try {
    const { machineId, label } = req.body;
    const qr = await printerQrService.generatePrinterQr(machineId, { label }, req.user);
    res.status(201).json({ success: true, data: { qr } });
  } catch (error) {
    next(error);
  }
};

const generatePrinterDeviceQr = async (req, res, next) => {
  try {
    const { label } = req.body || {};
    const qr = await printerQrService.generatePrinterDeviceQr(req.params.id, { label }, req.user);
    res.status(201).json({ success: true, data: { qr } });
  } catch (error) {
    next(error);
  }
};

const revokePrinterQr = async (req, res, next) => {
  try {
    const { reason } = req.body;
    const qr = await printerQrService.revokePrinterQr(req.params.id, reason, req.user);
    res.status(200).json({ success: true, message: 'Printer QR revoked successfully', data: { qr } });
  } catch (error) {
    next(error);
  }
};

const replacePrinterQr = async (req, res, next) => {
  try {
    const result = await printerQrService.replacePrinterQr(req.params.id, req.body, req.user);
    res.status(200).json({ success: true, message: 'Printer QR replaced successfully', data: result });
  } catch (error) {
    next(error);
  }
};

const getMachineQrLedger = async (req, res, next) => {
  try {
    const machineId = req.params.id;
    await printerQrService.verifyMachineAccess(machineId, req.user);
    const result = await printerQrService.listPrinterQrs(req.user, {
      machineId,
      legacyOnly: true,
      limit: 100
    });
    const activeQr = result.qrs.find((q) => q.status === 'ACTIVE') || null;
    const history = result.qrs.filter((q) => q.status !== 'ACTIVE');
    res.status(200).json({
      success: true,
      data: { activeQr, history, total: result.pagination.total }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  listPrinterQrs,
  getPrinterQrById,
  generatePrinterQr,
  generatePrinterDeviceQr,
  revokePrinterQr,
  replacePrinterQr,
  getMachineQrLedger
};
