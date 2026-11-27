jest.mock('../src/utils/prisma', () => ({}));

const prisma = require('../src/utils/prisma');
const {
  computePrinterDeviceAvailability,
  getPrinterDeviceAvailability,
  PRINTER_STATES
} = require('../src/services/printerAvailability.service');

describe('Dedicated printer status scope', () => {
  const now = new Date('2026-11-27T12:00:00.000Z');
  const machine = { id: 'machine-1', status: 'ACTIVE', lastOnline: new Date(now.getTime() - 15000) };

  const device = (id, healthStatus = 'ONLINE', ageMs = 10000) => ({
    id,
    displayName: id,
    printerModel: 'Test printer',
    status: 'ACTIVE',
    healthStatus,
    lastTelemetryAt: new Date(now.getTime() - ageMs)
  });

  test('fresh device telemetry reports ONLINE', () => {
    const result = computePrinterDeviceAvailability(machine, device('device-a'), now);
    expect(result.status).toBe(PRINTER_STATES.ONLINE);
    expect(result.isReady).toBe(true);
  });

  test('stale, missing and future device telemetry fail closed', () => {
    expect(computePrinterDeviceAvailability(machine, device('device-a', 'ONLINE', 181000), now).status)
      .toBe(PRINTER_STATES.UNKNOWN);
    expect(computePrinterDeviceAvailability(machine, { ...device('device-a'), lastTelemetryAt: null }, now).status)
      .toBe(PRINTER_STATES.UNKNOWN);
    expect(computePrinterDeviceAvailability(machine, device('device-a', 'ONLINE', -1000), now).status)
      .toBe(PRINTER_STATES.UNKNOWN);
  });

  test('agent offline overrides a fresh ONLINE child-device report', () => {
    const offlineMachine = { ...machine, lastOnline: new Date(now.getTime() - 91000) };
    const result = computePrinterDeviceAvailability(offlineMachine, device('device-a'), now);
    expect(result.status).toBe(PRINTER_STATES.AGENT_OFFLINE);
    expect(result.isReady).toBe(false);
  });

  test('parallel printer lookups stay bound to the requested device and machine', async () => {
    prisma.machine = { findUnique: jest.fn().mockResolvedValue(machine) };
    prisma.printerDevice = {
      findFirst: jest.fn(async ({ where }) => device(where.id))
    };

    const ids = ['epson-device', 'hp-device', 'canon-device'];
    const results = await Promise.all(ids.map((id) =>
      getPrinterDeviceAvailability('machine-1', id, prisma, now)
    ));

    expect(results.map((result) => result.printerDeviceId)).toEqual(ids);
    expect(prisma.printerDevice.findFirst.mock.calls.map(([args]) => args.where))
      .toEqual(ids.map((id) => ({ id, machineId: 'machine-1' })));
  });

  test('inactive device cannot report ready even with fresh ONLINE telemetry', () => {
    const result = computePrinterDeviceAvailability(machine, {
      ...device('device-a'),
      status: 'INACTIVE'
    }, now);
    expect(result.status).toBe(PRINTER_STATES.UNKNOWN);
    expect(result.isReady).toBe(false);
  });
});
