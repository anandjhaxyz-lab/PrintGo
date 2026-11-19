const printerDeviceAdminService = require('./printerDevice.admin.service');

const listPrinterDiscovery = async (req, res, next) => {
  try {
    const discoveries = await printerDeviceAdminService.listPrinterDiscovery(
      req.params.id,
      req.user,
      req.query
    );
    res.status(200).json({
      success: true,
      data: { discoveries }
    });
  } catch (error) {
    next(error);
  }
};

const listPrinterDevices = async (req, res, next) => {
  try {
    const devices = await printerDeviceAdminService.listPrinterDevices(req.params.id, req.user);
    res.status(200).json({
      success: true,
      data: { devices }
    });
  } catch (error) {
    next(error);
  }
};

const bindDiscoveredPrinterDevice = async (req, res, next) => {
  try {
    const result = await printerDeviceAdminService.bindDiscoveredPrinterDevice(
      req.params.id,
      req.body,
      req.user
    );
    res.status(result.alreadyBound ? 200 : 201).json({
      success: true,
      message: result.alreadyBound
        ? 'This discovered queue is already bound to its PrinterDevice.'
        : 'Windows queue mapped. Explicit Admin approval is still required before printing.',
      data: result
    });
  } catch (error) {
    next(error);
  }
};

const approvePrinterDevice = async (req, res, next) => {
  try {
    const result = await printerDeviceAdminService.approvePrinterDevice(req.params.id, req.user);
    res.status(200).json({
      success: true,
      message: result.alreadyApproved
        ? 'PrinterDevice is already approved.'
        : 'PrinterDevice approved. Agent registry will expose it as ACTIVE on its next synchronization.',
      data: result
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  listPrinterDiscovery,
  listPrinterDevices,
  bindDiscoveredPrinterDevice,
  approvePrinterDevice
};
