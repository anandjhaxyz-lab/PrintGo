jest.mock('../../src/utils/prisma', () => ({}));
const { getPrinterDeviceAvailability } = require('../../src/services/printerAvailability.service');

describe('device-scoped printer availability', () => {
  const now = new Date('2026-11-27T10:00:00.000Z');
  const machine = { id: 'm1', status: 'ACTIVE', lastOnline: new Date(now.getTime() - 10000) };
  const device = (id, overrides = {}) => ({
    id, displayName: 'Shop printer', printerModel: 'Epson', status: 'ACTIVE',
    healthStatus: 'ONLINE', lastTelemetryAt: new Date(now.getTime() - 10000), ...overrides
  });
  const dbFor = (printer) => ({
    machine: { findUnique: jest.fn().mockResolvedValue(machine) },
    printerDevice: { findFirst: jest.fn().mockResolvedValue(printer) }
  });

  test('queries only the requested device and returns ready from fresh device telemetry', async () => {
    const db = dbFor(device('d1'));
    const result = await getPrinterDeviceAvailability('m1', 'd1', db, now);
    expect(db.printerDevice.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'd1', machineId: 'm1' }
    }));
    expect(result).toMatchObject({ printerDeviceId: 'd1', status: 'ONLINE', isReady: true });
  });

  test('missing device and stale telemetry fail closed without machine aggregate fallback', async () => {
    const missingDb = dbFor(null);
    expect(await getPrinterDeviceAvailability('m1', 'd2', missingDb, now)).toBeNull();
    const staleDb = dbFor(device('d3', { lastTelemetryAt: new Date(now.getTime() - 181000) }));
    const stale = await getPrinterDeviceAvailability('m1', 'd3', staleDb, now);
    expect(stale).toMatchObject({ status: 'UNKNOWN', isReady: false, printerDeviceId: 'd3' });
  });
});
