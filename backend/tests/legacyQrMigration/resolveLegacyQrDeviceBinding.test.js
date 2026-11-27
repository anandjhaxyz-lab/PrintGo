const { resolveLegacyQrDeviceBinding } = require('../../src/legacyQrMigration/resolveLegacyQrDeviceBinding');
const qr = { id: 'legacy-qr', machineId: 'machine-1', status: 'ACTIVE', printerDeviceId: null };
const device = { id: 'epson-device', machineId: 'machine-1', status: 'ACTIVE', approvedAt: new Date('2026-11-27T00:00:00Z'), windowsPrinterName: 'EPSON L6460 Series' };
const binding = { printerQrId: 'legacy-qr', machineId: 'machine-1', printerDeviceId: 'epson-device', status: 'ACTIVE', approvedAt: new Date('2026-11-27T00:00:00Z'), approvedBy: 'operator-1' };
describe('legacy QR explicit binding policy (mock-only)', () => {
  test('accepts explicit approved same-machine Epson binding', () => expect(resolveLegacyQrDeviceBinding({ qr, binding, device })).toEqual({ ok: true, printerDeviceId: 'epson-device', source: 'EXPLICIT_APPROVED_LEGACY_BINDING' }));
  test('does not infer by label/model without binding', () => expect(resolveLegacyQrDeviceBinding({ qr, binding: null, device }).reason).toBe('EXPLICIT_BINDING_NOT_APPROVED'));
  test('rejects inactive QR', () => expect(resolveLegacyQrDeviceBinding({ qr: { ...qr, status: 'REVOKED' }, binding, device }).reason).toBe('QR_NOT_ACTIVE'));
  test('rejects already directly-bound QR', () => expect(resolveLegacyQrDeviceBinding({ qr: { ...qr, printerDeviceId: 'other' }, binding, device }).reason).toBe('QR_ALREADY_DEVICE_BOUND'));
  test('rejects binding to another QR or machine', () => {
    expect(resolveLegacyQrDeviceBinding({ qr, binding: { ...binding, printerQrId: 'other' }, device }).reason).toBe('BINDING_QR_OR_MACHINE_MISMATCH');
    expect(resolveLegacyQrDeviceBinding({ qr, binding: { ...binding, machineId: 'machine-2' }, device }).reason).toBe('BINDING_QR_OR_MACHINE_MISMATCH');
  });
  test('rejects cross-machine target device', () => expect(resolveLegacyQrDeviceBinding({ qr, binding, device: { ...device, machineId: 'machine-2' } }).reason).toBe('DEVICE_MACHINE_MISMATCH'));
  test('rejects unapproved, inactive, or queue-unbound target', () => {
    expect(resolveLegacyQrDeviceBinding({ qr, binding, device: { ...device, approvedAt: null } }).reason).toBe('DEVICE_NOT_APPROVED_ACTIVE_AND_QUEUE_BOUND');
    expect(resolveLegacyQrDeviceBinding({ qr, binding, device: { ...device, status: 'DISABLED' } }).reason).toBe('DEVICE_NOT_APPROVED_ACTIVE_AND_QUEUE_BOUND');
    expect(resolveLegacyQrDeviceBinding({ qr, binding, device: { ...device, windowsPrinterName: null } }).reason).toBe('DEVICE_NOT_APPROVED_ACTIVE_AND_QUEUE_BOUND');
  });
  test('requires binding approval audit metadata', () => {
    expect(resolveLegacyQrDeviceBinding({ qr, binding: { ...binding, approvedBy: null }, device }).reason).toBe('EXPLICIT_BINDING_NOT_APPROVED');
    expect(resolveLegacyQrDeviceBinding({ qr, binding: { ...binding, status: 'PENDING' }, device }).reason).toBe('EXPLICIT_BINDING_NOT_APPROVED');
  });
});
