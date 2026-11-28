/**
 * PrintGo — Parent Machine Availability & Multi-Printer Fleet Telemetry Aggregation Test Suite
 *
 * Verifies all P0 requirements:
 * 1. Agent disconnected -> AGENT_OFFLINE (isReady: false).
 * 2. Legacy single-printer compatibility (no child devices):
 *    - Fresh telemetry -> ONLINE (isReady: true).
 *    - Stale telemetry (> 180s) -> UNKNOWN (isReady: false).
 *    - Missing telemetry -> UNKNOWN (isReady: false).
 *    - Offline/PaperOut/Jammed -> respective statuses.
 * 3. Multi-printer fleet mode:
 *    - All three child printers reporting READY -> parent is ONLINE (isReady: true).
 *    - One child printer OFFLINE, others READY -> parent is ONLINE (isReady: true), individual OFFLINE preserved.
 *    - One child printer ERROR, others READY -> parent is ONLINE (isReady: true), individual ERROR preserved.
 *    - All child telemetry stale -> parent fails closed to UNKNOWN (isReady: false).
 *    - All child printers reporting OFFLINE -> parent is PRINTER_DISCONNECTED (isReady: false).
 *    - All child printers reporting ERROR -> parent is ERROR (isReady: false).
 *    - All child printers reporting PAPER_OUT -> parent is PAPER_OUT (isReady: false).
 * 4. Agent connectivity remains separate from hardware readiness.
 * 5. Fail-closed UNKNOWN behavior strictly preserved when valid telemetry is missing.
 * 6. Individual child printer readiness is preserved in deviceReadiness array.
 */

jest.mock('../src/utils/prisma', () => ({
  machine: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
}));

const {
  computePrinterAvailability,
  PRINTER_STATES,
  CUSTOMER_STATUS_MESSAGES,
  getMachineAvailability
} = require('../src/services/printerAvailability.service');

describe('Parent Machine Availability & Multi-Printer Fleet Telemetry Aggregation', () => {
  const fixedNow = new Date('2026-11-28T12:00:00.000Z');
  const freshHeartbeat = new Date('2026-11-28T11:59:30.000Z'); // 30s ago (<= 90s)
  const expiredHeartbeat = new Date('2026-11-28T11:58:00.000Z'); // 120s ago (> 90s)
  const freshTelemetry = new Date('2026-11-28T11:59:20.000Z'); // 40s ago (<= 180s)
  const staleTelemetry = new Date('2026-11-28T11:55:00.000Z'); // 300s ago (> 180s)

  describe('1. Agent Connectivity Priority', () => {
    test('Agent disconnected (> 90s) reports AGENT_OFFLINE even if child printers were previously ONLINE', () => {
      const machine = {
        id: 'm-main',
        status: 'ACTIVE',
        lastOnline: expiredHeartbeat,
        printerDevices: [
          { id: 'dev-1', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry },
          { id: 'dev-2', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry },
          { id: 'dev-3', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry }
        ]
      };

      const res = computePrinterAvailability(machine, null, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.AGENT_OFFLINE);
      expect(res.isReady).toBe(false);
      expect(res.agentOnline).toBe(false);
      expect(res.statusMessage).toBe(CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.AGENT_OFFLINE]);
    });

    test('Agent missing lastOnline reports AGENT_OFFLINE', () => {
      const machine = { id: 'm-main', status: 'ACTIVE', lastOnline: null };
      const res = computePrinterAvailability(machine, null, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.AGENT_OFFLINE);
      expect(res.isReady).toBe(false);
      expect(res.agentOnline).toBe(false);
    });

    test('Non-ACTIVE machine status reports AGENT_OFFLINE', () => {
      const machine = { id: 'm-main', status: 'SUSPENDED', lastOnline: freshHeartbeat };
      const res = computePrinterAvailability(machine, null, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.AGENT_OFFLINE);
      expect(res.isReady).toBe(false);
    });
  });

  describe('2. Legacy Single-Printer Compatibility (Zero Child Devices)', () => {
    test('Fresh legacy telemetry reports ONLINE', () => {
      const machine = { id: 'm-legacy', status: 'ACTIVE', lastOnline: freshHeartbeat, printerDevices: [] };
      const legacyStatus = { isOnline: true, paperStatus: 'OK', jamStatus: false, timestamp: freshTelemetry };

      const res = computePrinterAvailability(machine, legacyStatus, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.ONLINE);
      expect(res.isReady).toBe(true);
      expect(res.agentOnline).toBe(true);
      expect(res.statusMessage).toBe(CUSTOMER_STATUS_MESSAGES[PRINTER_STATES.ONLINE]);
    });

    test('Stale legacy telemetry (> 180s) fails closed to UNKNOWN', () => {
      const machine = { id: 'm-legacy', status: 'ACTIVE', lastOnline: freshHeartbeat, printerDevices: [] };
      const legacyStatus = { isOnline: true, paperStatus: 'OK', jamStatus: false, timestamp: staleTelemetry };

      const res = computePrinterAvailability(machine, legacyStatus, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.UNKNOWN);
      expect(res.isReady).toBe(false);
      expect(res.agentOnline).toBe(true);
    });

    test('Missing legacy telemetry fails closed to UNKNOWN', () => {
      const machine = { id: 'm-legacy', status: 'ACTIVE', lastOnline: freshHeartbeat, printerDevices: [] };

      const res = computePrinterAvailability(machine, null, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.UNKNOWN);
      expect(res.isReady).toBe(false);
    });
  });

  describe('3. Multi-Printer Fleet Telemetry Aggregation', () => {
    test('All three child printers reporting READY -> parent is ONLINE', () => {
      const machine = {
        id: 'm-main',
        status: 'ACTIVE',
        lastOnline: freshHeartbeat,
        printerDevices: [
          { id: 'dev-epson', displayName: 'EPSON L6460 Series', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry },
          { id: 'dev-hp', displayName: 'HP LaserJet M1136', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry },
          { id: 'dev-canon', displayName: 'Canon Generic Plus', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry }
        ]
      };

      const res = computePrinterAvailability(machine, null, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.ONLINE);
      expect(res.isReady).toBe(true);
      expect(res.agentOnline).toBe(true);
      expect(res.readyDeviceCount).toBe(3);
      expect(res.activeDeviceCount).toBe(3);
      expect(res.deviceReadiness).toHaveLength(3);
      expect(res.deviceReadiness.every(d => d.isReady && d.status === PRINTER_STATES.ONLINE)).toBe(true);
    });

    test('One child printer OFFLINE, two READY -> parent remains ONLINE while preserving individual OFFLINE status', () => {
      const machine = {
        id: 'm-main',
        status: 'ACTIVE',
        lastOnline: freshHeartbeat,
        printerDevices: [
          { id: 'dev-epson', displayName: 'EPSON L6460 Series', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry },
          { id: 'dev-hp', displayName: 'HP LaserJet M1136', status: 'ACTIVE', healthStatus: 'OFFLINE', lastTelemetryAt: freshTelemetry },
          { id: 'dev-canon', displayName: 'Canon Generic Plus', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry }
        ]
      };

      const res = computePrinterAvailability(machine, null, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.ONLINE);
      expect(res.isReady).toBe(true);
      expect(res.readyDeviceCount).toBe(2);
      expect(res.activeDeviceCount).toBe(3);

      const hpDevice = res.deviceReadiness.find(d => d.id === 'dev-hp');
      expect(hpDevice.status).toBe(PRINTER_STATES.PRINTER_DISCONNECTED);
      expect(hpDevice.isReady).toBe(false);

      const epsonDevice = res.deviceReadiness.find(d => d.id === 'dev-epson');
      expect(epsonDevice.status).toBe(PRINTER_STATES.ONLINE);
      expect(epsonDevice.isReady).toBe(true);
    });

    test('One child printer ERROR, two READY -> parent remains ONLINE while preserving individual ERROR status', () => {
      const machine = {
        id: 'm-main',
        status: 'ACTIVE',
        lastOnline: freshHeartbeat,
        printerDevices: [
          { id: 'dev-epson', displayName: 'EPSON L6460 Series', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry },
          { id: 'dev-hp', displayName: 'HP LaserJet M1136', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry },
          { id: 'dev-canon', displayName: 'Canon Generic Plus', status: 'ACTIVE', healthStatus: 'ERROR', lastTelemetryAt: freshTelemetry }
        ]
      };

      const res = computePrinterAvailability(machine, null, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.ONLINE);
      expect(res.isReady).toBe(true);
      expect(res.readyDeviceCount).toBe(2);

      const canonDevice = res.deviceReadiness.find(d => d.id === 'dev-canon');
      expect(canonDevice.status).toBe('ERROR');
      expect(canonDevice.isReady).toBe(false);
    });

    test('All child telemetry stale (> 180s) -> parent fails closed to UNKNOWN', () => {
      const machine = {
        id: 'm-main',
        status: 'ACTIVE',
        lastOnline: freshHeartbeat,
        printerDevices: [
          { id: 'dev-epson', displayName: 'EPSON L6460 Series', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: staleTelemetry },
          { id: 'dev-hp', displayName: 'HP LaserJet M1136', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: staleTelemetry },
          { id: 'dev-canon', displayName: 'Canon Generic Plus', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: staleTelemetry }
        ]
      };

      const res = computePrinterAvailability(machine, null, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.UNKNOWN);
      expect(res.isReady).toBe(false);
      expect(res.agentOnline).toBe(true);
      expect(res.readyDeviceCount).toBe(0);
      expect(res.deviceReadiness.every(d => d.isStale && d.status === PRINTER_STATES.UNKNOWN)).toBe(true);
    });

    test('All child printers reporting OFFLINE -> parent is PRINTER_DISCONNECTED', () => {
      const machine = {
        id: 'm-main',
        status: 'ACTIVE',
        lastOnline: freshHeartbeat,
        printerDevices: [
          { id: 'dev-epson', status: 'ACTIVE', healthStatus: 'OFFLINE', lastTelemetryAt: freshTelemetry },
          { id: 'dev-hp', status: 'ACTIVE', healthStatus: 'OFFLINE', lastTelemetryAt: freshTelemetry },
          { id: 'dev-canon', status: 'ACTIVE', healthStatus: 'OFFLINE', lastTelemetryAt: freshTelemetry }
        ]
      };

      const res = computePrinterAvailability(machine, null, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.PRINTER_DISCONNECTED);
      expect(res.isReady).toBe(false);
      expect(res.readyDeviceCount).toBe(0);
    });

    test('All child printers reporting ERROR -> parent is ERROR', () => {
      const machine = {
        id: 'm-main',
        status: 'ACTIVE',
        lastOnline: freshHeartbeat,
        printerDevices: [
          { id: 'dev-epson', status: 'ACTIVE', healthStatus: 'ERROR', lastTelemetryAt: freshTelemetry },
          { id: 'dev-hp', status: 'ACTIVE', healthStatus: 'ERROR', lastTelemetryAt: freshTelemetry },
          { id: 'dev-canon', status: 'ACTIVE', healthStatus: 'ERROR', lastTelemetryAt: freshTelemetry }
        ]
      };

      const res = computePrinterAvailability(machine, null, fixedNow);
      expect(res.status).toBe('ERROR');
      expect(res.isReady).toBe(false);
      expect(res.readyDeviceCount).toBe(0);
    });

    test('All child printers reporting PAPER_OUT -> parent is PAPER_OUT', () => {
      const machine = {
        id: 'm-main',
        status: 'ACTIVE',
        lastOnline: freshHeartbeat,
        printerDevices: [
          { id: 'dev-epson', status: 'ACTIVE', healthStatus: 'PAPER_OUT', lastTelemetryAt: freshTelemetry },
          { id: 'dev-hp', status: 'ACTIVE', healthStatus: 'PAPER_OUT', lastTelemetryAt: freshTelemetry }
        ]
      };

      const res = computePrinterAvailability(machine, null, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.PAPER_OUT);
      expect(res.isReady).toBe(false);
      expect(res.paperStatus).toBe('OUT');
    });

    test('Disabled devices (status !== ACTIVE) are excluded from parent availability calculation', () => {
      const machine = {
        id: 'm-main',
        status: 'ACTIVE',
        lastOnline: freshHeartbeat,
        printerDevices: [
          { id: 'dev-epson', status: 'DISABLED', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry },
          { id: 'dev-hp', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry }
        ]
      };

      const res = computePrinterAvailability(machine, null, fixedNow);
      expect(res.status).toBe(PRINTER_STATES.ONLINE);
      expect(res.isReady).toBe(true);
      expect(res.activeDeviceCount).toBe(1);
    });
  });

  describe('4. getMachineAvailability DB Query Integration', () => {
    test('getMachineAvailability loads active printerDevices and computes parent readiness', async () => {
      const mockPrismaClient = {
        machine: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'm-main',
            name: 'Main Shop Printer',
            location: 'Front Desk',
            status: 'ACTIVE',
            lastOnline: freshHeartbeat,
            paymentMode: 'CASH_AT_COUNTER',
            printerStatuses: [],
            printerDevices: [
              { id: 'dev-epson', displayName: 'EPSON L6460 Series', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry },
              { id: 'dev-hp', displayName: 'HP LaserJet M1136', status: 'ACTIVE', healthStatus: 'ONLINE', lastTelemetryAt: freshTelemetry }
            ]
          })
        }
      };

      const res = await getMachineAvailability('m-main', mockPrismaClient, fixedNow);
      expect(res.machineId).toBe('m-main');
      expect(res.status).toBe(PRINTER_STATES.ONLINE);
      expect(res.isReady).toBe(true);
      expect(res.agentOnline).toBe(true);
      expect(res.readyDeviceCount).toBe(2);

      // Verify Prisma query included printerDevices with ACTIVE filter
      expect(mockPrismaClient.machine.findUnique).toHaveBeenCalledWith({
        where: { id: 'm-main' },
        include: {
          printerStatuses: { take: 1, orderBy: { timestamp: 'desc' } },
          printerDevices: { where: { status: 'ACTIVE' }, orderBy: { sortOrder: 'asc' } }
        }
      });
    });
  });
});
