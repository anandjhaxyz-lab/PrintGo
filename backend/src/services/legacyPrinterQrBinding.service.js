const AppError = require('../utils/AppError');

const countNonWhitespaceCharacters = (value) => value.replace(/\s/g, '').length;

const validateLegacyQrAlias = ({ qr, binding, device }) => {
  if (!qr || qr.status !== 'ACTIVE' || !qr.machineId) throw new AppError('Legacy QR is not active or machine-bound.', 403);
  if (!binding || binding.status !== 'ACTIVE' || !binding.approvedAt || !binding.approvedBy) throw new AppError('Legacy QR has no explicitly approved physical-printer alias.', 403);
  if (binding.printerQrId !== qr.id || binding.machineId !== qr.machineId) throw new AppError('Legacy QR alias identity mismatch.', 403);

  // A legacy alias may augment only a NULL-bound QR or the exact Phase 1
  // placeholder. It must never override a QR already mapped to a real device.
  if (qr.printerDeviceId) {
    const mapped = qr.printerDevice || null;
    const isPlaceholder = mapped
      ? mapped.id === qr.printerDeviceId &&
        mapped.machineId === qr.machineId &&
        mapped.isDefault === true &&
        mapped.status === 'DISCOVERY_REQUIRED' &&
        !mapped.approvedAt &&
        !mapped.windowsPrinterName
      : qr.printer_device_id === qr.printerDeviceId &&
        qr.printer_device_machine_id === qr.machineId &&
        qr.printer_device_is_default === true &&
        qr.printer_device_status === 'DISCOVERY_REQUIRED' &&
        !qr.printer_device_approved_at &&
        !qr.printer_device_windows_printer_name;
    if (!isPlaceholder) throw new AppError('Legacy alias cannot override a QR mapped to a non-placeholder printer device.', 409);
  }

  if (!device || device.id !== binding.printerDeviceId || device.machineId !== qr.machineId) throw new AppError('Legacy QR alias target identity mismatch.', 403);
  if (device.status !== 'ACTIVE' || !device.approvedAt || !device.windowsPrinterName) throw new AppError('Legacy QR alias target is not approved, active, and queue-bound.', 403);
  return device;
};

const approveLegacyQrBinding = async ({ prisma, qrId, printerDeviceId, reason, user }) => {
  if (!reason || typeof reason !== 'string' || countNonWhitespaceCharacters(reason) < 10) throw new AppError('A meaningful approval reason of at least 10 non-whitespace characters is required.', 400);
  if (!user || user.role !== 'SUPERADMIN') throw new AppError('Only SUPERADMIN may approve a legacy QR printer alias.', 403);
  return prisma.$transaction(async (tx) => {
    const qrs = await tx.$queryRawUnsafe('SELECT id, "machineId", "printerDeviceId", status FROM "PrinterQr" WHERE id = $1 FOR UPDATE', qrId);
    if (!qrs?.length) throw new AppError('Legacy QR not found.', 404);
    const qr = qrs[0];
    if (qr.status !== 'ACTIVE' || !qr.machineId) throw new AppError('Only an active machine-bound legacy QR can receive an alias.', 409);
    if (qr.printerDeviceId) {
      const placeholders = await tx.$queryRawUnsafe(
        'SELECT id, "machineId", status, "approvedAt", "windowsPrinterName", "isDefault" FROM "PrinterDevice" WHERE id = $1 FOR UPDATE',
        qr.printerDeviceId
      );
      const placeholder = placeholders?.[0];
      const isLegacyPlaceholder = Boolean(
        placeholder &&
        placeholder.id === qr.printerDeviceId &&
        placeholder.machineId === qr.machineId &&
        placeholder.isDefault === true &&
        placeholder.status === 'DISCOVERY_REQUIRED' &&
        !placeholder.approvedAt &&
        !placeholder.windowsPrinterName
      );
      if (!isLegacyPlaceholder) throw new AppError('Only an unbound legacy QR or a QR attached to its exact pending primary placeholder can receive an alias.', 409);
    }
    const devices = await tx.$queryRawUnsafe('SELECT id, "machineId", status, "approvedAt", "windowsPrinterName", "displayName", "printerModel", "isDefault" FROM "PrinterDevice" WHERE id = $1 FOR UPDATE', printerDeviceId);
    const device = devices?.[0];
    if (!device || device.machineId !== qr.machineId || device.status !== 'ACTIVE' || !device.approvedAt || !device.windowsPrinterName) throw new AppError('Target device must be approved, active, queue-bound, and on the same machine.', 409);
    const existing = await tx.$queryRawUnsafe('SELECT id FROM "LegacyPrinterQrBinding" WHERE "printerQrId" = $1 FOR UPDATE', qrId);
    if (existing?.length) throw new AppError('A legacy QR binding record already exists; use the audited revoke/review workflow.', 409);
    const id = require('crypto').randomUUID();
    await tx.$executeRawUnsafe('INSERT INTO "LegacyPrinterQrBinding" ("id","printerQrId","machineId","printerDeviceId","status","reason","approvedAt","approvedBy","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,NOW(),NOW())', id, qr.id, qr.machineId, device.id, 'ACTIVE', reason.trim(), user.id || user.email);
    return { id, printerQrId: qr.id, machineId: qr.machineId, printerDeviceId: device.id, status: 'ACTIVE' };
  }, { maxWait: 10000, timeout: 10000 });
};

const revokeLegacyQrBinding = async ({ prisma, qrId, reason, user }) => {
  if (!reason || typeof reason !== 'string' || countNonWhitespaceCharacters(reason) < 10) throw new AppError('A meaningful revocation reason of at least 10 non-whitespace characters is required.', 400);
  if (!user || user.role !== 'SUPERADMIN') throw new AppError('Only SUPERADMIN may revoke a legacy QR printer alias.', 403);
  return prisma.$transaction(async (tx) => {
    const qrs = await tx.$queryRawUnsafe('SELECT id, status FROM "PrinterQr" WHERE id = $1 FOR UPDATE', qrId);
    if (!qrs?.length) throw new AppError('Legacy QR not found.', 404);
    const rows = await tx.$queryRawUnsafe('SELECT id, status, "printerDeviceId" FROM "LegacyPrinterQrBinding" WHERE "printerQrId" = $1 FOR UPDATE', qrId);
    if (!rows?.length) throw new AppError('Legacy QR binding not found.', 404);
    const binding = rows[0];
    if (binding.status === 'REVOKED') return { id: binding.id, printerQrId: qrId, status: 'REVOKED', alreadyRevoked: true };
    if (binding.status !== 'ACTIVE') throw new AppError('Only an ACTIVE legacy QR binding can be revoked.', 409);
    await tx.$executeRawUnsafe('UPDATE "LegacyPrinterQrBinding" SET status = $1, "revokedAt" = NOW(), "revokedBy" = $2, "revokedReason" = $3, "updatedAt" = NOW() WHERE id = $4', 'REVOKED', user.id || user.email, reason.trim(), binding.id);
    return { id: binding.id, printerQrId: qrId, printerDeviceId: binding.printerDeviceId, status: 'REVOKED' };
  }, { maxWait: 10000, timeout: 10000 });
};

module.exports = { validateLegacyQrAlias, approveLegacyQrBinding, revokeLegacyQrBinding };
