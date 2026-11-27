/**
 * Pure policy helper for a proposed explicit legacy QR -> PrinterDevice binding.
 * No database access, writes, network calls, or QR/token handling.
 */
function resolveLegacyQrDeviceBinding({ qr, binding, device }) {
  if (!qr || qr.status !== 'ACTIVE') return { ok: false, reason: 'QR_NOT_ACTIVE' };
  if (!qr.machineId) return { ok: false, reason: 'QR_MACHINE_MISSING' };
  if (qr.printerDeviceId) return { ok: false, reason: 'QR_ALREADY_DEVICE_BOUND' };
  if (!binding || binding.status !== 'ACTIVE' || !binding.approvedAt || !binding.approvedBy) return { ok: false, reason: 'EXPLICIT_BINDING_NOT_APPROVED' };
  if (binding.printerQrId !== qr.id || binding.machineId !== qr.machineId) return { ok: false, reason: 'BINDING_QR_OR_MACHINE_MISMATCH' };
  if (!device || device.id !== binding.printerDeviceId) return { ok: false, reason: 'DEVICE_NOT_FOUND_OR_ID_MISMATCH' };
  if (device.machineId !== qr.machineId) return { ok: false, reason: 'DEVICE_MACHINE_MISMATCH' };
  if (device.status !== 'ACTIVE' || !device.approvedAt || !device.windowsPrinterName) return { ok: false, reason: 'DEVICE_NOT_APPROVED_ACTIVE_AND_QUEUE_BOUND' };
  return { ok: true, printerDeviceId: device.id, source: 'EXPLICIT_APPROVED_LEGACY_BINDING' };
}
module.exports = { resolveLegacyQrDeviceBinding };
