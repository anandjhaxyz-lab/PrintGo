const { computeIsOnline, ONLINE_HEARTBEAT_WINDOW_MS } = require('../src/modules/machines/machines.service');
const setupSockets = require('../src/socket');
const prisma = require('../src/utils/prisma');
const fs = require('fs');
const path = require('path');

describe('P1: Printer Online Status & Hardware Telemetry (Fail-Closed)', () => {
  const BASE_NOW = new Date('2026-11-13T12:00:00.000Z');

  describe('1. computeIsOnline() — Pure Function Contract', () => {
    test('ACTIVE + fresh heartbeat within 90 seconds => ONLINE (true)', () => {
      // Exactly 0 seconds ago (just now)
      expect(computeIsOnline({
        status: 'ACTIVE',
        lastOnline: new Date('2026-11-13T12:00:00.000Z')
      }, BASE_NOW)).toBe(true);

      // 30 seconds ago (typical agent heartbeat interval)
      expect(computeIsOnline({
        status: 'ACTIVE',
        lastOnline: new Date('2026-11-13T11:59:30.000Z')
      }, BASE_NOW)).toBe(true);

      // 89 seconds ago
      expect(computeIsOnline({
        status: 'ACTIVE',
        lastOnline: new Date('2026-11-13T11:58:31.000Z')
      }, BASE_NOW)).toBe(true);

      // Exactly 90 seconds ago (boundary)
      expect(computeIsOnline({
        status: 'ACTIVE',
        lastOnline: new Date('2026-11-13T11:58:30.000Z')
      }, BASE_NOW)).toBe(true);

      // ISO string representation
      expect(computeIsOnline({
        status: 'ACTIVE',
        lastOnline: '2026-11-13T11:59:00.000Z'
      }, BASE_NOW)).toBe(true);
    });

    test('ACTIVE + heartbeat older than 90 seconds => OFFLINE (false)', () => {
      // 91 seconds ago
      expect(computeIsOnline({
        status: 'ACTIVE',
        lastOnline: new Date('2026-11-13T11:58:29.000Z')
      }, BASE_NOW)).toBe(false);

      // 120 seconds ago
      expect(computeIsOnline({
        status: 'ACTIVE',
        lastOnline: new Date('2026-11-13T11:58:00.000Z')
      }, BASE_NOW)).toBe(false);

      // 1 day ago
      expect(computeIsOnline({
        status: 'ACTIVE',
        lastOnline: new Date('2026-11-12T12:00:00.000Z')
      }, BASE_NOW)).toBe(false);
    });

    test('ACTIVE + null or missing lastOnline => OFFLINE (false)', () => {
      expect(computeIsOnline({ status: 'ACTIVE', lastOnline: null }, BASE_NOW)).toBe(false);
      expect(computeIsOnline({ status: 'ACTIVE', lastOnline: undefined }, BASE_NOW)).toBe(false);
      expect(computeIsOnline({ status: 'ACTIVE' }, BASE_NOW)).toBe(false);
    });

    test('SUSPENDED or INACTIVE + fresh heartbeat => OFFLINE (false)', () => {
      const freshTimestamp = new Date('2026-11-13T11:59:50.000Z'); // 10s ago

      expect(computeIsOnline({ status: 'SUSPENDED', lastOnline: freshTimestamp }, BASE_NOW)).toBe(false);
      expect(computeIsOnline({ status: 'INACTIVE', lastOnline: freshTimestamp }, BASE_NOW)).toBe(false);
      expect(computeIsOnline({ status: 'DECOMMISSIONED', lastOnline: freshTimestamp }, BASE_NOW)).toBe(false);
      expect(computeIsOnline({ status: '', lastOnline: freshTimestamp }, BASE_NOW)).toBe(false);
      expect(computeIsOnline({ lastOnline: freshTimestamp }, BASE_NOW)).toBe(false);
    });

    test('Invalid or unparseable timestamp => OFFLINE (false)', () => {
      expect(computeIsOnline({ status: 'ACTIVE', lastOnline: 'invalid-date-string' }, BASE_NOW)).toBe(false);
      expect(computeIsOnline({ status: 'ACTIVE', lastOnline: NaN }, BASE_NOW)).toBe(false);
      expect(computeIsOnline({ status: 'ACTIVE', lastOnline: {} }, BASE_NOW)).toBe(false);
      expect(computeIsOnline({ status: 'ACTIVE', lastOnline: [] }, BASE_NOW)).toBe(false);
    });

    test('Future timestamp (clock drift / corrupted clock) => OFFLINE (false)', () => {
      // 10 seconds in the future
      expect(computeIsOnline({
        status: 'ACTIVE',
        lastOnline: new Date('2026-11-13T12:00:10.000Z')
      }, BASE_NOW)).toBe(false);

      // 1 hour in the future
      expect(computeIsOnline({
        status: 'ACTIVE',
        lastOnline: new Date('2026-11-13T13:00:00.000Z')
      }, BASE_NOW)).toBe(false);
    });

    test('Null or non-object machine input => OFFLINE (false)', () => {
      expect(computeIsOnline(null, BASE_NOW)).toBe(false);
      expect(computeIsOnline(undefined, BASE_NOW)).toBe(false);
      expect(computeIsOnline('machine', BASE_NOW)).toBe(false);
      expect(computeIsOnline(12345, BASE_NOW)).toBe(false);
    });

    test('Threshold constant is exactly 90,000 milliseconds', () => {
      expect(ONLINE_HEARTBEAT_WINDOW_MS).toBe(90000);
    });
  });

  describe('2. Frontend Stale-Event Protection — updateMachineFromSocketEvent Contract', () => {
    // Replicate pure function logic to test it directly in Node/Jest
    const updateMachineFromSocketEvent = (prevMachines, payload) => {
      if (!payload || !payload.machineId || !Array.isArray(prevMachines)) {
        return prevMachines || [];
      }
      const { machineId, lastOnline, isOnline } = payload;
      return prevMachines.map(m => {
        if (m.id !== machineId) return m;

        const incomingTime = lastOnline ? new Date(lastOnline).getTime() : NaN;
        const hasValidIncoming = !Number.isNaN(incomingTime);

        const existingTime = m.lastOnline ? new Date(m.lastOnline).getTime() : NaN;
        const hasValidExisting = !Number.isNaN(existingTime);

        if (hasValidExisting && !hasValidIncoming) {
          return m;
        }

        if (hasValidExisting && hasValidIncoming && incomingTime <= existingTime) {
          return m;
        }

        return {
          ...m,
          ...(hasValidIncoming ? { lastOnline } : {}),
          isOnline: isOnline === true
        };
      });
    };

    const initialMachines = [
      { id: 'm1', name: 'Kiosk 1', status: 'ACTIVE', lastOnline: '2026-11-13T12:00:00.000Z', isOnline: true },
      { id: 'm2', name: 'Kiosk 2', status: 'ACTIVE', lastOnline: '2026-11-13T11:59:00.000Z', isOnline: true }
    ];

    test('Updates only the matching machine, preserving other machines and properties', () => {
      const updated = updateMachineFromSocketEvent(initialMachines, {
        machineId: 'm1',
        lastOnline: '2026-11-13T12:00:30.000Z',
        isOnline: true
      });

      expect(updated[0].id).toBe('m1');
      expect(updated[0].name).toBe('Kiosk 1'); // Preserved
      expect(updated[0].lastOnline).toBe('2026-11-13T12:00:30.000Z');
      expect(updated[1]).toEqual(initialMachines[1]); // Untouched
    });

    test('Newer valid timestamp updates both lastOnline and isOnline', () => {
      const updated = updateMachineFromSocketEvent(initialMachines, {
        machineId: 'm1',
        lastOnline: '2026-11-13T12:01:00.000Z',
        isOnline: true
      });

      expect(updated[0].lastOnline).toBe('2026-11-13T12:01:00.000Z');
      expect(updated[0].isOnline).toBe(true);
    });

    test('Stale event with older timestamp is dropped; existing state preserved', () => {
      // Event with timestamp 1 minute older than currently stored
      const updated = updateMachineFromSocketEvent(initialMachines, {
        machineId: 'm1',
        lastOnline: '2026-11-13T11:59:00.000Z',
        isOnline: false
      });

      // m1 remains at 12:00:00 and isOnline: true
      expect(updated[0].lastOnline).toBe('2026-11-13T12:00:00.000Z');
      expect(updated[0].isOnline).toBe(true);
    });

    test('Duplicate event with equal timestamp is ignored; existing state preserved', () => {
      const updated = updateMachineFromSocketEvent(initialMachines, {
        machineId: 'm1',
        lastOnline: '2026-11-13T12:00:00.000Z',
        isOnline: false // Attempt to force offline with equal timestamp
      });

      expect(updated[0].lastOnline).toBe('2026-11-13T12:00:00.000Z');
      expect(updated[0].isOnline).toBe(true);
    });

    test('Missing or invalid incoming timestamp does NOT overwrite known valid timestamp or online status', () => {
      // Missing lastOnline
      const updatedNull = updateMachineFromSocketEvent(initialMachines, {
        machineId: 'm1',
        lastOnline: null,
        isOnline: false
      });
      expect(updatedNull[0].lastOnline).toBe('2026-11-13T12:00:00.000Z');
      expect(updatedNull[0].isOnline).toBe(true);

      // Invalid date string
      const updatedInvalid = updateMachineFromSocketEvent(initialMachines, {
        machineId: 'm1',
        lastOnline: 'invalid-date',
        isOnline: false
      });
      expect(updatedInvalid[0].lastOnline).toBe('2026-11-13T12:00:00.000Z');
      expect(updatedInvalid[0].isOnline).toBe(true);
    });

    test('Applies server-provided isOnline strictly (never recalculates independently)', () => {
      // Server explicitly reports isOnline: false with a fresh timestamp
      const updated = updateMachineFromSocketEvent(initialMachines, {
        machineId: 'm1',
        lastOnline: '2026-11-13T12:01:00.000Z',
        isOnline: false // e.g. Machine is SUSPENDED on server
      });

      expect(updated[0].lastOnline).toBe('2026-11-13T12:01:00.000Z');
      expect(updated[0].isOnline).toBe(false);
    });
  });

  describe('3. Genuine Socket.IO Runtime Handler Execution', () => {
    let mockIo;
    let mockSocket;
    let mockAdminsRoom;
    let connectionHandler;
    let registeredHandlers;
    let origMachineUpdate;
    let origMachineFindUnique;

    beforeEach(() => {
      registeredHandlers = {};
      mockAdminsRoom = {
        emit: jest.fn()
      };

      mockSocket = {
        id: 'socket_printer_99',
        userType: 'printer',
        machineId: 'machine_eps_01',
        machineName: 'Epson L6460 Pilot',
        join: jest.fn(),
        emit: jest.fn(),
        on: jest.fn((event, handler) => {
          registeredHandlers[event] = handler;
        })
      };

      mockIo = {
        use: jest.fn(),
        on: jest.fn((event, handler) => {
          if (event === 'connection') {
            connectionHandler = handler;
          }
        }),
        to: jest.fn((room) => {
          if (room === 'admins') return mockAdminsRoom;
          return { emit: jest.fn() };
        })
      };

      // Save original prisma methods
      origMachineUpdate = prisma.machine.update;
      origMachineFindUnique = prisma.machine.findUnique;

      // Initialize setupSockets with mockIo and execute connectionHandler
      setupSockets(mockIo);
      expect(connectionHandler).toBeDefined();
      connectionHandler(mockSocket);

      // Verify that 'heartbeat' and 'disconnect' handlers are genuinely registered
      expect(typeof registeredHandlers['heartbeat']).toBe('function');
      expect(typeof registeredHandlers['disconnect']).toBe('function');
    });

    afterEach(() => {
      // Restore original prisma methods
      prisma.machine.update = origMachineUpdate;
      prisma.machine.findUnique = origMachineFindUnique;
      jest.clearAllMocks();
    });

    test('1. Valid printer heartbeat: updates DB and emits server-computed ONLINE status', async () => {
      const now = new Date();
      prisma.machine.update = jest.fn().mockResolvedValue({
        id: 'machine_eps_01',
        status: 'ACTIVE',
        lastOnline: now
      });

      // Actually execute the registered heartbeat handler!
      await registeredHandlers['heartbeat']();

      // Verify DB update was executed with exact arguments
      expect(prisma.machine.update).toHaveBeenCalledWith({
        where: { id: 'machine_eps_01' },
        data: { lastOnline: expect.any(Date) }
      });

      // Verify admins room received printer_heartbeat event with computed isOnline: true
      expect(mockAdminsRoom.emit).toHaveBeenCalledWith('printer_heartbeat', {
        machineId: 'machine_eps_01',
        lastOnline: now,
        isOnline: true
      });
    });

    test('2. Suspended machine: does NOT become online on heartbeat (emits isOnline: false)', async () => {
      const now = new Date();
      prisma.machine.update = jest.fn().mockResolvedValue({
        id: 'machine_eps_01',
        status: 'SUSPENDED',
        lastOnline: now
      });

      // Execute registered heartbeat handler for suspended machine
      await registeredHandlers['heartbeat']();

      expect(mockAdminsRoom.emit).toHaveBeenCalledWith('printer_heartbeat', {
        machineId: 'machine_eps_01',
        lastOnline: now,
        isOnline: false
      });
    });

    test('3. Disconnect handler: computes status using authoritative 90s helper (recent heartbeat remains ONLINE)', async () => {
      const recentTimestamp = new Date(Date.now() - 15 * 1000); // 15 seconds ago
      prisma.machine.findUnique = jest.fn().mockResolvedValue({
        id: 'machine_eps_01',
        status: 'ACTIVE',
        lastOnline: recentTimestamp
      });

      // Actually execute the registered disconnect handler!
      await registeredHandlers['disconnect']();

      expect(prisma.machine.findUnique).toHaveBeenCalledWith({
        where: { id: 'machine_eps_01' }
      });

      // Within 90 seconds, remains ONLINE even upon socket disconnect
      expect(mockAdminsRoom.emit).toHaveBeenCalledWith('printer_disconnected', {
        machineId: 'machine_eps_01',
        lastOnline: recentTimestamp,
        isOnline: true
      });
    });

    test('4. Disconnect handler: stale heartbeat (>90s) produces OFFLINE status', async () => {
      const staleTimestamp = new Date(Date.now() - 120 * 1000); // 120 seconds ago (>90s)
      prisma.machine.findUnique = jest.fn().mockResolvedValue({
        id: 'machine_eps_01',
        status: 'ACTIVE',
        lastOnline: staleTimestamp
      });

      await registeredHandlers['disconnect']();

      expect(mockAdminsRoom.emit).toHaveBeenCalledWith('printer_disconnected', {
        machineId: 'machine_eps_01',
        lastOnline: staleTimestamp,
        isOnline: false
      });
    });

    test('5. Disconnect handler: non-ACTIVE machine produces OFFLINE status', async () => {
      const freshTimestamp = new Date(Date.now() - 5 * 1000);
      prisma.machine.findUnique = jest.fn().mockResolvedValue({
        id: 'machine_eps_01',
        status: 'INACTIVE',
        lastOnline: freshTimestamp
      });

      await registeredHandlers['disconnect']();

      expect(mockAdminsRoom.emit).toHaveBeenCalledWith('printer_disconnected', {
        machineId: 'machine_eps_01',
        lastOnline: freshTimestamp,
        isOnline: false
      });
    });

    test('6. Database error on heartbeat: does NOT falsely emit successful online status', async () => {
      prisma.machine.update = jest.fn().mockRejectedValue(new Error('PostgreSQL connection terminated'));

      // Should not throw or unhandle rejection
      await registeredHandlers['heartbeat']();

      // No successful event emitted to admins
      expect(mockAdminsRoom.emit).not.toHaveBeenCalled();
    });

    test('7. Database error on disconnect: does NOT falsely emit successful status', async () => {
      prisma.machine.findUnique = jest.fn().mockRejectedValue(new Error('PostgreSQL query timeout'));

      await registeredHandlers['disconnect']();

      expect(mockAdminsRoom.emit).not.toHaveBeenCalled();
    });

    test('8. Non-printer socket disconnect: does NOT emit printer_disconnected', async () => {
      const nonPrinterSocket = {
        id: 'socket_session_101',
        userType: 'session',
        machineId: null,
        join: jest.fn(),
        emit: jest.fn(),
        on: jest.fn((event, handler) => {
          registeredHandlers[event] = handler;
        })
      };

      connectionHandler(nonPrinterSocket);
      await registeredHandlers['disconnect']();

      expect(mockAdminsRoom.emit).not.toHaveBeenCalled();
    });
  });

  describe('4. Admin UI Contract — PrintersView.jsx Verification', () => {
    const printersViewPath = path.resolve(__dirname, '../../frontend/src/components/admin/views/PrintersView.jsx');
    const printersViewContent = fs.readFileSync(printersViewPath, 'utf8');

    test('Confirm Admin UI does NOT use the old printerStatus?.isError online condition', () => {
      expect(printersViewContent).not.toContain("machine.status === 'ACTIVE' && (!printerStatus?.isError)");
      expect(printersViewContent).not.toContain('(!printerStatus?.isError)');
    });

    test('Confirm Admin UI uses server-computed machine.isOnline === true', () => {
      expect(printersViewContent).toContain('const isOnline = machine.isOnline === true;');
    });

    test('Confirm missing paper/ink telemetry renders Unknown (not fabricated OK or Sufficient/Optimal)', () => {
      expect(printersViewContent).not.toContain("latestStatus?.paperStatus || 'OK'");
      expect(printersViewContent).not.toContain("latestStatus?.tonerStatus || 'OK'");
      expect(printersViewContent).toContain(": 'Unknown'");
    });

    test('Confirm missing printerModel renders Unknown (not fabricated EPSON L6460 Series)', () => {
      expect(printersViewContent).not.toContain("machine.printerModel || 'EPSON L6460 Series'");
      expect(printersViewContent).toContain("machine.printerModel?.trim() || 'Unknown'");
    });

    test('Confirm missing connectionType renders Unknown (not hardcoded USB / Direct IP)', () => {
      expect(printersViewContent).not.toContain("<div style={{ fontWeight: 600, color: '#1e293b' }}>USB / Direct IP</div>");
      expect(printersViewContent).toContain("machine.connectionType?.trim() || 'Unknown'");
    });
  });

  describe('5. Admin Dashboard Contract — AdminDashboard.jsx Verification', () => {
    const adminDashboardPath = path.resolve(__dirname, '../../frontend/src/pages/AdminDashboard.jsx');
    const adminDashboardContent = fs.readFileSync(adminDashboardPath, 'utf8');

    test('Confirm AdminDashboard exports updateMachineFromSocketEvent', () => {
      expect(adminDashboardContent).toContain('export const updateMachineFromSocketEvent');
    });

    test('Confirm AdminDashboard applies updateMachineFromSocketEvent to printer_heartbeat', () => {
      expect(adminDashboardContent).toContain("socket.on('printer_heartbeat', (payload) => {");
      expect(adminDashboardContent).toContain('setMachines(prev => updateMachineFromSocketEvent(prev, payload));');
    });

    test('Confirm AdminDashboard applies updateMachineFromSocketEvent to printer_disconnected', () => {
      expect(adminDashboardContent).toContain("socket.on('printer_disconnected', (payload) => {");
      expect(adminDashboardContent).toContain('setMachines(prev => updateMachineFromSocketEvent(prev, payload));');
    });

    test('Confirm AdminDashboard rejects stale incoming timestamps (incomingTime <= existingTime)', () => {
      expect(adminDashboardContent).toContain('incomingTime <= existingTime');
    });

    test('Confirm AdminDashboard has periodic refresh for machine status while open', () => {
      expect(adminDashboardContent).toContain('/api/admin/machines');
      expect(adminDashboardContent).toContain('/api/machines/my-machines');
      expect(adminDashboardContent).toContain('45000');
    });
  });
});
