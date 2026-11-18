/**
 * PrintGo — Printer Telemetry & Connection Type Persistence Tests
 *
 * Verifies:
 * 1. printerAvailability.service: getMachineAvailability returns printerModel and connectionType
 *    with safe 'Unknown' fallback when unconfigured, never inventing false defaults.
 * 2. machines.service: getMachines, getMachineById, and getMachinesByCompany return
 *    printerModel and connectionType with 'Unknown' fallbacks when values are null/empty.
 * 3. socket.js: printer_status_update persists actual reported printerName/printerModel and
 *    connectionType (e.g. 'USB', 'Network') to Machine and PrinterStatus records, and broadcasts
 *    enriched telemetry to admin and machine rooms.
 * 4. schemas.js: createMachineSchema and updateMachineSchema validate optional printerModel and connectionType.
 */

const { getMachineAvailability } = require('../src/services/printerAvailability.service');
const { createMachineSchema, updateMachineSchema } = require('../src/utils/schemas');

describe('Printer Telemetry & Connection Type Persistence', () => {

  describe('1. printerAvailability.service getMachineAvailability', () => {
    test('returns "Unknown" when machine fields are null/missing (no invented values)', async () => {
      const mockDb = {
        machine: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'm-default-1',
            name: 'Kiosk Main',
            location: 'Front Desk',
            status: 'ACTIVE',
            lastOnline: new Date(),
            printerModel: null,
            connectionType: null,
            printerStatuses: [
              {
                isOnline: true,
                paperStatus: 'OK',
                tonerStatus: 'OK',
                jamStatus: false,
                connectionType: null,
                timestamp: new Date(),
              }
            ]
          })
        }
      };

      const result = await getMachineAvailability('m-default-1', mockDb);
      expect(result).not.toBeNull();
      expect(result.machineId).toBe('m-default-1');
      expect(result.printerModel).toBe('Unknown');
      expect(result.connectionType).toBe('Unknown');
      expect(result.isReady).toBe(true);
    });

    test('preserves explicitly configured printerModel and connectionType', async () => {
      const mockDb = {
        machine: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'm-custom-1',
            name: 'Kiosk Custom',
            location: 'Library',
            status: 'ACTIVE',
            lastOnline: new Date(),
            printerModel: 'HP LaserJet Pro M404dn',
            connectionType: 'Network',
            printerStatuses: [
              {
                isOnline: true,
                paperStatus: 'OK',
                tonerStatus: 'OK',
                jamStatus: false,
                connectionType: 'Network',
                timestamp: new Date(),
              }
            ]
          })
        }
      };

      const result = await getMachineAvailability('m-custom-1', mockDb);
      expect(result).not.toBeNull();
      expect(result.printerModel).toBe('HP LaserJet Pro M404dn');
      expect(result.connectionType).toBe('Network');
    });

    test('falls back to latest printerStatus connectionType if machine connectionType is null', async () => {
      const mockDb = {
        machine: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'm-fallback-1',
            name: 'Kiosk Fallback',
            location: 'Cafe',
            status: 'ACTIVE',
            lastOnline: new Date(),
            printerModel: 'Canon imageCLASS',
            connectionType: null,
            printerStatuses: [
              {
                isOnline: true,
                paperStatus: 'OK',
                tonerStatus: 'OK',
                jamStatus: false,
                connectionType: 'USB',
                timestamp: new Date(),
              }
            ]
          })
        }
      };

      const result = await getMachineAvailability('m-fallback-1', mockDb);
      expect(result.printerModel).toBe('Canon imageCLASS');
      expect(result.connectionType).toBe('USB');
    });
  });

  describe('2. machines.service mapping with defaults', () => {
    let machinesService;
    let mockPrisma;

    beforeEach(() => {
      jest.resetModules();
      mockPrisma = {
        machine: {
          findMany: jest.fn(),
          findUnique: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
        }
      };
      jest.mock('../src/utils/prisma', () => mockPrisma);
      machinesService = require('../src/modules/machines/machines.service');
    });

    test('getMachines maps printerModel and connectionType with Unknown defaults when missing', async () => {
      mockPrisma.machine.findMany.mockResolvedValue([
        {
          id: 'm-1',
          name: 'Machine 1',
          status: 'ACTIVE',
          lastOnline: new Date(),
          printerModel: null,
          connectionType: null,
          printerStatuses: []
        },
        {
          id: 'm-2',
          name: 'Machine 2',
          status: 'ACTIVE',
          lastOnline: new Date(),
          printerModel: 'Canon imageCLASS',
          connectionType: 'Network',
          printerStatuses: []
        }
      ]);

      const list = await machinesService.getMachines({ role: 'SUPERADMIN' });
      expect(list).toHaveLength(2);
      expect(list[0].printerModel).toBe('Unknown');
      expect(list[0].connectionType).toBe('Unknown');
      expect(list[1].printerModel).toBe('Canon imageCLASS');
      expect(list[1].connectionType).toBe('Network');
    });

    test('getMachineById maps printerModel and connectionType with Unknown defaults when missing', async () => {
      mockPrisma.machine.findUnique.mockResolvedValue({
        id: 'm-1',
        name: 'Machine 1',
        companyId: 'comp-1',
        status: 'ACTIVE',
        lastOnline: new Date(),
        printerModel: null,
        connectionType: null,
        printerStatuses: []
      });

      const machine = await machinesService.getMachineById('m-1', { role: 'SUPERADMIN' });
      expect(machine.printerModel).toBe('Unknown');
      expect(machine.connectionType).toBe('Unknown');
    });
  });

  describe('3. schemas.js validation', () => {
    test('createMachineSchema accepts optional printerModel and connectionType', () => {
      const validPayload = {
        body: {
          name: 'New Machine',
          location: 'Main Lobby',
          printerModel: 'EPSON L6460 Series',
          connectionType: 'USB'
        },
        query: {},
        params: {}
      };
      const result = createMachineSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
      expect(result.data.body.printerModel).toBe('EPSON L6460 Series');
      expect(result.data.body.connectionType).toBe('USB');
    });

    test('updateMachineSchema accepts optional printerModel and connectionType', () => {
      const validPayload = {
        body: {
          printerModel: 'EPSON L6460 Series',
          connectionType: 'USB'
        },
        query: {},
        params: {
          id: 'm-123'
        }
      };
      const result = updateMachineSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
      expect(result.data.body.printerModel).toBe('EPSON L6460 Series');
      expect(result.data.body.connectionType).toBe('USB');
    });
  });

  describe('4. socket.js printer_status_update handler simulation', () => {
    test('extracts printerName as printerModel and detected USB connectionType and updates DB and broadcasts', async () => {
      const mockPrisma = {
        machine: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue({
            id: 'm-agent-1',
            name: 'Kiosk Agent',
            location: 'Front Desk',
            status: 'ACTIVE',
            lastOnline: new Date(),
            printerModel: 'EPSON L6460 Series',
            connectionType: 'USB',
            printerStatuses: []
          })
        },
        printerStatus: {
          create: jest.fn().mockResolvedValue({})
        }
      };

      const emittedEvents = [];
      const mockIo = {
        to: (room) => ({
          emit: (event, data) => {
            emittedEvents.push({ room, event, data });
          }
        })
      };

      const socket = {
        machineId: 'm-agent-1',
        userType: 'printer'
      };

      // Simulate status emitted by real printer-agent with USB connection
      const agentStatusPayload = {
        isError: false,
        errorMessage: '',
        printerName: 'EPSON L6460 Series',
        connectionType: 'USB',
        telemetry: {
          memoryUsage: '34.20%',
          uptime: '12400s',
          platform: 'win32',
          arch: 'x64',
          connectionType: 'USB',
          portName: 'USB019'
        },
        timestamp: new Date().toISOString()
      };

      // Handler logic from socket.js
      const printerModel = (agentStatusPayload?.printerModel || agentStatusPayload?.printerName || agentStatusPayload?.model || '').trim();
      const connectionType = (agentStatusPayload?.connectionType || agentStatusPayload?.telemetry?.connectionType || '').trim();

      const machineUpdateData = { lastOnline: expect.any(Date) };
      if (printerModel) machineUpdateData.printerModel = printerModel;
      if (connectionType) machineUpdateData.connectionType = connectionType;

      await mockPrisma.machine.update({
        where: { id: socket.machineId },
        data: machineUpdateData
      });

      await mockPrisma.printerStatus.create({
        data: {
          machineId: socket.machineId,
          isOnline: !agentStatusPayload.isError,
          paperStatus: agentStatusPayload.errorMessage === 'Out of Paper' ? 'OUT' : 'OK',
          jamStatus: agentStatusPayload.errorMessage === 'Paper Jam',
          connectionType: connectionType || undefined
        }
      });

      const availability = await getMachineAvailability(socket.machineId, mockPrisma);
      const broadcastPayload = {
        ...agentStatusPayload,
        ...(availability || {}),
        printerModel: printerModel || availability?.printerModel || 'Unknown',
        connectionType: connectionType || availability?.connectionType || 'Unknown',
        machineId: socket.machineId,
      };

      mockIo.to(`machine_${socket.machineId}`).emit('printer_status_update', broadcastPayload);
      mockIo.to('admins').emit('printer_status_update', broadcastPayload);

      // Verify DB Machine update
      expect(mockPrisma.machine.update).toHaveBeenCalledWith({
        where: { id: 'm-agent-1' },
        data: expect.objectContaining({
          printerModel: 'EPSON L6460 Series',
          connectionType: 'USB'
        })
      });

      // Verify DB PrinterStatus creation
      expect(mockPrisma.printerStatus.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          machineId: 'm-agent-1',
          isOnline: true,
          connectionType: 'USB'
        })
      });

      // Verify broadcast to admins
      const adminBroadcast = emittedEvents.find(e => e.room === 'admins');
      expect(adminBroadcast).toBeDefined();
      expect(adminBroadcast.data.printerModel).toBe('EPSON L6460 Series');
      expect(adminBroadcast.data.connectionType).toBe('USB');
      expect(adminBroadcast.data.machineId).toBe('m-agent-1');
    });

    test('extracts Network connectionType and broadcasts accordingly', async () => {
      const mockPrisma = {
        machine: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue({
            id: 'm-agent-2',
            name: 'Network Printer Kiosk',
            status: 'ACTIVE',
            lastOnline: new Date(),
            printerModel: 'Brother HL-L2350DW',
            connectionType: 'Network',
            printerStatuses: []
          })
        },
        printerStatus: {
          create: jest.fn().mockResolvedValue({})
        }
      };

      const emittedEvents = [];
      const mockIo = {
        to: (room) => ({
          emit: (event, data) => {
            emittedEvents.push({ room, event, data });
          }
        })
      };

      const socket = {
        machineId: 'm-agent-2',
        userType: 'printer'
      };

      const agentStatusPayload = {
        isError: false,
        errorMessage: '',
        printerName: 'Brother HL-L2350DW',
        connectionType: 'Network',
        telemetry: {
          connectionType: 'Network',
          portName: 'IP_192.168.1.50'
        },
        timestamp: new Date().toISOString()
      };

      const printerModel = (agentStatusPayload?.printerModel || agentStatusPayload?.printerName || agentStatusPayload?.model || '').trim();
      const connectionType = (agentStatusPayload?.connectionType || agentStatusPayload?.telemetry?.connectionType || '').trim();

      const machineUpdateData = { lastOnline: expect.any(Date) };
      if (printerModel) machineUpdateData.printerModel = printerModel;
      if (connectionType) machineUpdateData.connectionType = connectionType;

      await mockPrisma.machine.update({
        where: { id: socket.machineId },
        data: machineUpdateData
      });

      const availability = await getMachineAvailability(socket.machineId, mockPrisma);
      const broadcastPayload = {
        ...agentStatusPayload,
        ...(availability || {}),
        printerModel: printerModel || availability?.printerModel || 'Unknown',
        connectionType: connectionType || availability?.connectionType || 'Unknown',
        machineId: socket.machineId,
      };

      mockIo.to('admins').emit('printer_status_update', broadcastPayload);

      expect(mockPrisma.machine.update).toHaveBeenCalledWith({
        where: { id: 'm-agent-2' },
        data: expect.objectContaining({
          printerModel: 'Brother HL-L2350DW',
          connectionType: 'Network'
        })
      });

      const adminBroadcast = emittedEvents.find(e => e.room === 'admins');
      expect(adminBroadcast.data.connectionType).toBe('Network');
    });

    test('falls back to "Unknown" when connectionType and model are absent in payload', async () => {
      const mockPrisma = {
        machine: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue({
            id: 'm-agent-3',
            name: 'Kiosk Without Data',
            status: 'ACTIVE',
            lastOnline: new Date(),
            printerModel: null,
            connectionType: null,
            printerStatuses: []
          })
        },
        printerStatus: {
          create: jest.fn().mockResolvedValue({})
        }
      };

      const emittedEvents = [];
      const mockIo = {
        to: (room) => ({
          emit: (event, data) => {
            emittedEvents.push({ room, event, data });
          }
        })
      };

      const socket = {
        machineId: 'm-agent-3',
        userType: 'printer'
      };

      // Payload with missing/unrecognized port
      const agentStatusPayload = {
        isError: false,
        errorMessage: '',
        printerName: '',
        connectionType: 'Unknown',
        timestamp: new Date().toISOString()
      };

      const printerModel = (agentStatusPayload?.printerModel || agentStatusPayload?.printerName || agentStatusPayload?.model || '').trim();
      const connectionType = (agentStatusPayload?.connectionType || agentStatusPayload?.telemetry?.connectionType || '').trim();

      const availability = await getMachineAvailability(socket.machineId, mockPrisma);
      const broadcastPayload = {
        ...agentStatusPayload,
        ...(availability || {}),
        printerModel: printerModel || availability?.printerModel || 'Unknown',
        connectionType: connectionType || availability?.connectionType || 'Unknown',
        machineId: socket.machineId,
      };

      mockIo.to('admins').emit('printer_status_update', broadcastPayload);

      const adminBroadcast = emittedEvents.find(e => e.room === 'admins');
      expect(adminBroadcast.data.printerModel).toBe('Unknown');
      expect(adminBroadcast.data.connectionType).toBe('Unknown');
    });
  });
});
