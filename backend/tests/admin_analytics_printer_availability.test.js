/**
 * PrintGo — Phase 3.12: Admin Analytics Authoritative Printer Availability Test Suite
 *
 * Verifies that the Admin Executive Overview KPI calculates printer availability
 * using the centralized authoritative computePrinterAvailability engine instead of
 * relying on static database column values (m.status === 'ACTIVE').
 *
 * Minimum test requirements:
 * 1. Machine status ACTIVE + missing heartbeat -> 0 online, 1 offline.
 * 2. Machine status ACTIVE + heartbeat older than 90 seconds -> offline.
 * 3. Fresh heartbeat + missing telemetry -> offline/unknown, never online.
 * 4. Fresh heartbeat + stale telemetry older than 180 seconds -> offline/unknown.
 * 5. Fresh heartbeat + fresh connected telemetry -> online.
 * 6. Fresh heartbeat + fresh disconnected telemetry -> offline/error.
 * 7. Multiple machines produce correct total, online and offline counts.
 * 8. Franchisee company scoping is preserved.
 * 9. Prisma query requests the latest printer telemetry correctly.
 *
 * Verifies the API's existing hardware response shape:
 * - totalMachines
 * - activePrinters
 * - offlinePrinters
 */

const mockPrisma = {
  machine: {
    findMany: jest.fn(),
  },
  printJob: {
    findMany: jest.fn(),
  },
  refund: {
    findMany: jest.fn(),
  },
};

jest.mock('../src/utils/prisma', () => mockPrisma);

const { getOverviewStats, getSalesChartsData } = require('../src/services/adminAnalytics.service');

describe('Phase 3.12 — Authoritative Printer Availability in Admin Overview Analytics', () => {
  const superadminUser = { id: 'admin-1', role: 'SUPERADMIN', email: 'admin@printgo.in' };
  const franchiseeUser = { id: 'fran-1', role: 'FRANCHISEE', companyId: 'comp-franchise-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.printJob.findMany.mockResolvedValue([]);
    mockPrisma.refund.findMany.mockResolvedValue([]);
  });

  test('1. Machine status ACTIVE + missing heartbeat -> 0 online, 1 offline', async () => {
    mockPrisma.machine.findMany.mockResolvedValue([
      {
        id: 'm-1',
        status: 'ACTIVE',
        lastOnline: null,
        printerStatuses: [],
      },
    ]);

    const res = await getOverviewStats(superadminUser, { period: 'today' });

    expect(res.hardware).toBeDefined();
    expect(res.hardware).toEqual({
      totalMachines: 1,
      activePrinters: 0,
      offlinePrinters: 1,
    });
  });

  test('2. Machine status ACTIVE + heartbeat older than 90 seconds -> offline', async () => {
    const expiredHeartbeat = new Date(Date.now() - 120 * 1000); // 120s ago (> 90s)
    mockPrisma.machine.findMany.mockResolvedValue([
      {
        id: 'm-2',
        status: 'ACTIVE',
        lastOnline: expiredHeartbeat,
        printerStatuses: [
          {
            timestamp: new Date(),
            isOnline: true,
            paperStatus: 'OK',
            jamStatus: false,
          },
        ],
      },
    ]);

    const res = await getOverviewStats(superadminUser, { period: '30d' });

    expect(res.hardware).toEqual({
      totalMachines: 1,
      activePrinters: 0,
      offlinePrinters: 1,
    });
  });

  test('3. Fresh heartbeat + missing telemetry -> offline/unknown, never online', async () => {
    const freshHeartbeat = new Date(Date.now() - 15 * 1000); // 15s ago (<= 90s)
    mockPrisma.machine.findMany.mockResolvedValue([
      {
        id: 'm-3',
        status: 'ACTIVE',
        lastOnline: freshHeartbeat,
        printerStatuses: [], // No telemetry rows
      },
    ]);

    const res = await getOverviewStats(superadminUser, { period: '30d' });

    expect(res.hardware).toEqual({
      totalMachines: 1,
      activePrinters: 0,
      offlinePrinters: 1,
    });
  });

  test('4. Fresh heartbeat + stale telemetry older than 180 seconds -> offline/unknown', async () => {
    const freshHeartbeat = new Date(Date.now() - 10 * 1000);
    const staleTelemetry = new Date(Date.now() - 240 * 1000); // 4 minutes ago (> 180s)
    mockPrisma.machine.findMany.mockResolvedValue([
      {
        id: 'm-4',
        status: 'ACTIVE',
        lastOnline: freshHeartbeat,
        printerStatuses: [
          {
            timestamp: staleTelemetry,
            isOnline: true,
            paperStatus: 'OK',
            jamStatus: false,
          },
        ],
      },
    ]);

    const res = await getOverviewStats(superadminUser, { period: '30d' });

    expect(res.hardware).toEqual({
      totalMachines: 1,
      activePrinters: 0,
      offlinePrinters: 1,
    });
  });

  test('5. Fresh heartbeat + fresh connected telemetry -> online', async () => {
    const freshHeartbeat = new Date(Date.now() - 10 * 1000);
    const freshTelemetry = new Date(Date.now() - 15 * 1000);
    mockPrisma.machine.findMany.mockResolvedValue([
      {
        id: 'm-5',
        status: 'ACTIVE',
        lastOnline: freshHeartbeat,
        printerStatuses: [
          {
            timestamp: freshTelemetry,
            isOnline: true,
            paperStatus: 'OK',
            jamStatus: false,
            tonerStatus: 'OK',
          },
        ],
      },
    ]);

    const res = await getOverviewStats(superadminUser, { period: '30d' });

    expect(res.hardware).toEqual({
      totalMachines: 1,
      activePrinters: 1,
      offlinePrinters: 0,
    });
  });

  test('6. Fresh heartbeat + fresh disconnected telemetry -> offline/error', async () => {
    const freshHeartbeat = new Date(Date.now() - 10 * 1000);
    const freshTelemetry = new Date(Date.now() - 15 * 1000);
    mockPrisma.machine.findMany.mockResolvedValue([
      {
        id: 'm-6',
        status: 'ACTIVE',
        lastOnline: freshHeartbeat,
        printerStatuses: [
          {
            timestamp: freshTelemetry,
            isOnline: false, // Disconnected physical printer
            paperStatus: 'OK',
            jamStatus: false,
          },
        ],
      },
    ]);

    const res = await getOverviewStats(superadminUser, { period: '30d' });

    expect(res.hardware).toEqual({
      totalMachines: 1,
      activePrinters: 0,
      offlinePrinters: 1,
    });
  });

  test('7. Multiple machines produce correct total, online and offline counts', async () => {
    const freshTime = new Date(Date.now() - 10 * 1000);
    const staleTime = new Date(Date.now() - 300 * 1000);

    mockPrisma.machine.findMany.mockResolvedValue([
      // Machine 1: Online & Ready
      {
        id: 'm-ready',
        status: 'ACTIVE',
        lastOnline: freshTime,
        printerStatuses: [{ timestamp: freshTime, isOnline: true, paperStatus: 'OK', jamStatus: false }],
      },
      // Machine 2: Agent Offline (missing heartbeat)
      {
        id: 'm-agent-off',
        status: 'ACTIVE',
        lastOnline: staleTime,
        printerStatuses: [{ timestamp: freshTime, isOnline: true }],
      },
      // Machine 3: Printer Disconnected
      {
        id: 'm-printer-disc',
        status: 'ACTIVE',
        lastOnline: freshTime,
        printerStatuses: [{ timestamp: freshTime, isOnline: false }],
      },
      // Machine 4: Telemetry Stale
      {
        id: 'm-telemetry-stale',
        status: 'ACTIVE',
        lastOnline: freshTime,
        printerStatuses: [{ timestamp: staleTime, isOnline: true }],
      },
      // Machine 5: Inactive administrative status
      {
        id: 'm-inactive',
        status: 'INACTIVE',
        lastOnline: freshTime,
        printerStatuses: [{ timestamp: freshTime, isOnline: true }],
      },
    ]);

    const res = await getOverviewStats(superadminUser, { period: '30d' });

    expect(res.hardware).toEqual({
      totalMachines: 5,
      activePrinters: 1,
      offlinePrinters: 4,
    });
  });

  test('8. Franchisee company scoping is preserved', async () => {
    mockPrisma.machine.findMany.mockResolvedValue([]);

    await getOverviewStats(franchiseeUser, { period: '30d' });

    expect(mockPrisma.machine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'comp-franchise-1' },
      })
    );

    // Contrast with SUPERADMIN scoping
    mockPrisma.machine.findMany.mockClear();
    await getOverviewStats(superadminUser, { period: '30d' });

    expect(mockPrisma.machine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
      })
    );
  });

  test('9. Prisma query requests the latest printer telemetry correctly', async () => {
    mockPrisma.machine.findMany.mockResolvedValue([]);

    await getOverviewStats(superadminUser, { period: 'today' });

    expect(mockPrisma.machine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          status: true,
          lastOnline: true,
          printerStatuses: {
            take: 1,
            orderBy: { timestamp: 'desc' },
          },
        },
      })
    );
  });

  test('10. Hardware response structure has exact required fields', async () => {
    mockPrisma.machine.findMany.mockResolvedValue([]);

    const res = await getOverviewStats(superadminUser, { period: 'today' });

    expect(res).toHaveProperty('hardware');
    expect(res.hardware).toHaveProperty('totalMachines');
    expect(res.hardware).toHaveProperty('activePrinters');
    expect(res.hardware).toHaveProperty('offlinePrinters');
    expect(Object.keys(res.hardware).sort()).toEqual(['activePrinters', 'offlinePrinters', 'totalMachines'].sort());
  });
  test('12. Daily charts separate actual collections, Service Value, and completed print value', async () => {
    const chartTime = new Date(Date.now() - 30 * 60 * 1000);
    mockPrisma.machine.findMany.mockResolvedValue([
      { id: 'machine-1', name: 'Main Shop Printer', location: 'Front Desk' }
    ]);
    mockPrisma.printJob.findMany.mockResolvedValue([
      {
        id: 'chart-service',
        status: 'COMPLETED',
        paymentMode: 'DEMO_SIMULATION',
        cost: 2,
        color: 'bw',
        duplex: 'single',
        paperSize: 'A4',
        createdAt: chartTime,
        payment: {
          id: 'chart-payment-service',
          status: 'SUCCESS',
          amount: 2,
          paymentMethod: 'demo',
          paymentGroup: 'simulated',
          gatewayOrderId: 'demo_order_chart_service'
        },
        machine: { name: 'Main Shop Printer' }
      },
      {
        id: 'chart-cash',
        status: 'COMPLETED',
        cost: 3,
        color: 'bw',
        duplex: 'single',
        paperSize: 'A4',
        createdAt: chartTime,
        payment: {
          id: 'chart-payment-cash',
          status: 'SUCCESS',
          amount: 3,
          paymentMethod: 'cash',
          paymentGroup: 'cash',
          gatewayOrderId: 'cash_order_chart_cash'
        },
        machine: { name: 'Main Shop Printer' }
      },
      {
        id: 'chart-failed-service',
        status: 'FAILED',
        paymentMode: 'DEMO_SIMULATION',
        cost: 5,
        color: 'bw',
        duplex: 'single',
        paperSize: 'A4',
        createdAt: chartTime,
        payment: {
          id: 'chart-payment-failed',
          status: 'SUCCESS',
          amount: 5,
          paymentMethod: 'demo',
          paymentGroup: 'simulated',
          gatewayOrderId: 'demo_order_chart_failed'
        },
        machine: { name: 'Main Shop Printer' }
      }
    ]);

    const result = await getSalesChartsData(superadminUser, { period: 'today' });
    expect(result.dailyTrend).toHaveLength(1);
    expect(result.dailyTrend[0].grossRevenue).toBe(3);
    expect(result.dailyTrend[0].serviceValue).toBe(2);
    expect(result.dailyTrend[0].demoRevenue).toBe(2);
    expect(result.dailyTrend[0].completedPrintValue).toBe(5);
    expect(result.paymentMethods).toEqual(expect.arrayContaining([
      { name: 'Service Value', count: 1 },
      { name: 'cash', count: 1 }
    ]));
  });

  test('11. Completed Service Value contributes to print value but never to actual collections', async () => {
    mockPrisma.machine.findMany.mockResolvedValue([]);
    mockPrisma.printJob.findMany.mockResolvedValue([
      {
        id: 'job-service-value',
        status: 'COMPLETED',
        cost: 2,
        isTest: false,
        payment: {
          id: 'payment-service-value',
          status: 'SUCCESS',
          amount: 2,
          paymentMethod: 'demo',
          paymentGroup: 'simulated',
          gatewayOrderId: 'demo_order_service_1'
        }
      },
      {
        id: 'job-cash',
        status: 'COMPLETED',
        cost: 3,
        isTest: false,
        payment: {
          id: 'payment-cash',
          status: 'SUCCESS',
          amount: 3,
          paymentMethod: 'cash',
          paymentGroup: 'cash',
          gatewayOrderId: 'cash_order_cash_1'
        }
      },
      {
        id: 'job-service-value-without-payment-relation',
        status: 'COMPLETED',
        paymentMode: 'DEMO_SIMULATION',
        cost: 7,
        isTest: false,
        payment: null
      },
      {
        id: 'job-failed-service',
        status: 'FAILED',
        paymentMode: 'DEMO_SIMULATION',
        cost: 5,
        isTest: false,
        payment: {
          id: 'payment-failed-service',
          status: 'SUCCESS',
          amount: 5,
          paymentMethod: 'demo',
          paymentGroup: 'simulated',
          gatewayOrderId: 'demo_order_failed_1'
        }
      }
    ]);
    mockPrisma.refund.findMany.mockResolvedValue([]);

    const res = await getOverviewStats(superadminUser, { period: 'today' });

    expect(res.financials.completedPrintValue).toBe(12);
    expect(res.financials.serviceValue).toBe(9);
    expect(res.financials.demoCollections).toBe(9);
    expect(res.financials.grossCollections).toBe(3);
    expect(res.financials.netCollections).toBe(3);
    expect(res.financials.successfulPayments).toBe(1);
    expect(res.financials.serviceValueOrders).toBe(2);
  });
});
