const { approveLegacyQrBinding } = require('../../src/services/legacyPrinterQrBinding.service');

const makeTx = ({ qr, device, placeholder = null, existing = [] } = {}) => ({
  $queryRawUnsafe: jest.fn(async (sql, id) => {
    if (sql.includes('FROM "PrinterQr"')) return qr ? [qr] : [];
    if (sql.includes('FROM "PrinterDevice"')) {
      if (id === placeholder?.id) return [placeholder];
      if (id === device?.id) return [device];
      return [];
    }
    if (sql.includes('FROM "LegacyPrinterQrBinding"')) return existing;
    return [];
  }),
  $executeRawUnsafe: jest.fn(async () => 1)
});
const prismaFor = (tx) => ({ $transaction: (fn) => fn(tx) });
const qr = { id: 'q1', machineId: 'm1', status: 'ACTIVE', printerDeviceId: null };
const placeholder = { id: 'placeholder', machineId: 'm1', status: 'DISCOVERY_REQUIRED', approvedAt: null, windowsPrinterName: null, isDefault: true };
const device = { id: 'd1', machineId: 'm1', status: 'ACTIVE', approvedAt: new Date(), windowsPrinterName: 'EPSON L6460 Series' };
const user = { id: 'admin-1', role: 'SUPERADMIN' };

describe('legacy QR binding approval transaction (mock-only)', () => {
  test('creates explicit audited binding for same-machine approved device from a NULL-bound legacy QR', async () => {
    const tx = makeTx({ qr, device });
    const result = await approveLegacyQrBinding({ prisma: prismaFor(tx), qrId: 'q1', printerDeviceId: 'd1', reason: 'Bind counter QR to Epson', user });
    expect(result).toMatchObject({ printerQrId: 'q1', machineId: 'm1', printerDeviceId: 'd1', status: 'ACTIVE' });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });
  test('creates binding for the historical QR attached to the exact pending primary placeholder', async () => {
    const tx = makeTx({ qr: { ...qr, printerDeviceId: placeholder.id }, placeholder, device });
    const result = await approveLegacyQrBinding({ prisma: prismaFor(tx), qrId: 'q1', printerDeviceId: 'd1', reason: 'Bind old Epson counter QR', user });
    expect(result).toMatchObject({ printerQrId: 'q1', printerDeviceId: 'd1', status: 'ACTIVE' });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });
  test('rejects a QR attached to a non-placeholder or cross-machine device', async () => {
    await expect(approveLegacyQrBinding({ prisma: prismaFor(makeTx({ qr: { ...qr, printerDeviceId: 'other' }, placeholder: { ...placeholder, id: 'other', isDefault: false }, device })), qrId: 'q1', printerDeviceId: 'd1', reason: 'Bind old Epson counter QR', user })).rejects.toThrow(/pending primary placeholder/);
    await expect(approveLegacyQrBinding({ prisma: prismaFor(makeTx({ qr: { ...qr, printerDeviceId: placeholder.id }, placeholder: { ...placeholder, machineId: 'm2' }, device })), qrId: 'q1', printerDeviceId: 'd1', reason: 'Bind old Epson counter QR', user })).rejects.toThrow(/pending primary placeholder/);
  });
  test('rejects non-superadmin before opening transaction', async () => {
    const prisma = { $transaction: jest.fn() };
    await expect(approveLegacyQrBinding({ prisma, qrId: 'q1', printerDeviceId: 'd1', reason: 'Bind counter QR to Epson', user: { role: 'FRANCHISEE' } })).rejects.toThrow(/SUPERADMIN/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  test('rejects short reason', async () => {
    await expect(approveLegacyQrBinding({ prisma: prismaFor(makeTx({ qr, device })), qrId: 'q1', printerDeviceId: 'd1', reason: 'short', user })).rejects.toThrow(/10 non-whitespace/);
  });
  test('counts only non-whitespace characters in approval reasons', async () => {
    const prisma = prismaFor(makeTx({ qr, device }));
    await expect(approveLegacyQrBinding({ prisma, qrId: 'q1', printerDeviceId: 'd1', reason: 'abc def ghi', user })).rejects.toThrow(/10 non-whitespace/);
    const result = await approveLegacyQrBinding({ prisma: prismaFor(makeTx({ qr, device })), qrId: 'q1', printerDeviceId: 'd1', reason: 'abc def ghij', user });
    expect(result.status).toBe('ACTIVE');
    const tabNewlineResult = await approveLegacyQrBinding({ prisma: prismaFor(makeTx({ qr, device })), qrId: 'q1', printerDeviceId: 'd1', reason: 'abc\tdef\nghij', user });
    expect(tabNewlineResult.status).toBe('ACTIVE');
  });
  test('rejects cross-machine or unapproved target', async () => {
    await expect(approveLegacyQrBinding({ prisma: prismaFor(makeTx({ qr, device: { ...device, machineId: 'm2' } })), qrId: 'q1', printerDeviceId: 'd1', reason: 'Bind counter QR to Epson', user })).rejects.toThrow(/same machine/);
    await expect(approveLegacyQrBinding({ prisma: prismaFor(makeTx({ qr, device: { ...device, approvedAt: null } })), qrId: 'q1', printerDeviceId: 'd1', reason: 'Bind counter QR to Epson', user })).rejects.toThrow(/same machine/);
  });
  test('rejects existing binding; does not overwrite', async () => {
    await expect(approveLegacyQrBinding({ prisma: prismaFor(makeTx({ qr, device, existing: [{ id: 'binding-existing' }] })), qrId: 'q1', printerDeviceId: 'd1', reason: 'Bind counter QR to Epson', user })).rejects.toThrow(/already exists/);
  });
  test('rejects missing QR or device', async () => {
    await expect(approveLegacyQrBinding({ prisma: prismaFor(makeTx({ device })), qrId: 'missing', printerDeviceId: 'd1', reason: 'Bind counter QR to Epson', user })).rejects.toThrow(/not found/);
    await expect(approveLegacyQrBinding({ prisma: prismaFor(makeTx({ qr })), qrId: 'q1', printerDeviceId: 'missing', reason: 'Bind counter QR to Epson', user })).rejects.toThrow(/same machine/);
  });
});
