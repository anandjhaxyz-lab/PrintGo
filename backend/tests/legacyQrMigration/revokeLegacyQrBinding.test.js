const { revokeLegacyQrBinding, approveLegacyQrBinding } = require('../../src/services/legacyPrinterQrBinding.service');
const user = { id: 'root-1', role: 'SUPERADMIN' };
const makeTx = (binding) => ({
  $queryRawUnsafe: jest.fn(async (sql) => sql.includes('FROM "PrinterQr"') ? [{ id: 'q1', status: 'ACTIVE' }] : (binding ? [binding] : [])),
  $executeRawUnsafe: jest.fn(async () => 1)
});
const prismaFor = (tx) => ({ $transaction: (fn) => fn(tx) });
describe('legacy QR alias revocation lifecycle', () => {
  test('SUPERADMIN revokes active binding and records audit fields', async () => {
    const tx = makeTx({ id: 'b1', status: 'ACTIVE', printerDeviceId: 'd1' });
    const result = await revokeLegacyQrBinding({ prisma: prismaFor(tx), qrId: 'q1', reason: 'Retiring old counter mapping', user });
    expect(result).toMatchObject({ id: 'b1', status: 'REVOKED', printerDeviceId: 'd1' });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('revokedReason'), 'REVOKED', 'root-1', 'Retiring old counter mapping', 'b1');
  });
  test('revocation is idempotent for an already revoked binding', async () => {
    const tx = makeTx({ id: 'b1', status: 'REVOKED', printerDeviceId: 'd1' });
    await expect(revokeLegacyQrBinding({ prisma: prismaFor(tx), qrId: 'q1', reason: 'Retiring old counter mapping', user })).resolves.toMatchObject({ status: 'REVOKED', alreadyRevoked: true });
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  test('rejects non-SUPERADMIN, short reason and missing binding', async () => {
    await expect(revokeLegacyQrBinding({ prisma: { $transaction: jest.fn() }, qrId: 'q1', reason: 'valid reason text', user: { role: 'ADMIN' } })).rejects.toThrow(/SUPERADMIN/);
    await expect(revokeLegacyQrBinding({ prisma: prismaFor(makeTx({ id: 'b1', status: 'ACTIVE' })), qrId: 'q1', reason: 'short', user })).rejects.toThrow(/10 non-whitespace/);
    await expect(revokeLegacyQrBinding({ prisma: prismaFor(makeTx(null)), qrId: 'q1', reason: 'valid reason text', user })).rejects.toThrow(/binding not found/);
  });
  test('revoked binding is a terminal tombstone and cannot be approved again', async () => {
    const tx = makeTx({ id: 'b1', status: 'REVOKED' });
    const device = { id: 'd1', machineId: 'm1', status: 'ACTIVE', approvedAt: new Date(), windowsPrinterName: 'Queue' };
    tx.$queryRawUnsafe.mockImplementation(async (sql) => sql.includes('FROM "PrinterQr"') ? [{ id:'q1', machineId:'m1', status:'ACTIVE', printerDeviceId:null }] : sql.includes('FROM "PrinterDevice"') ? [device] : [{ id:'b1', status:'REVOKED' }]);
    await expect(approveLegacyQrBinding({ prisma: prismaFor(tx), qrId:'q1', printerDeviceId:'d1', reason:'Reapproval must not erase history', user })).rejects.toThrow(/record already exists/);
  });
});
