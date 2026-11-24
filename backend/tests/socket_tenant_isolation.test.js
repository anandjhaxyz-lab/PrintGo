const setupSockets = require('../src/socket');
const {
  handlePrinterInventoryReport,
  handlePrinterDeviceTelemetry
} = require('../src/services/printerAgentProtocol.service');

describe('Socket.IO Tenant Isolation & Global Admin Room Boundary', () => {
  let connectionHandler = null;
  let authMiddleware = null;
  let mockIo = null;

  beforeEach(() => {
    mockIo = {
      use: jest.fn((middleware) => {
        authMiddleware = middleware;
      }),
      on: jest.fn((event, handler) => {
        if (event === 'connection') {
          connectionHandler = handler;
        }
      }),
      to: jest.fn().mockReturnThis(),
      emit: jest.fn()
    };
    setupSockets(mockIo);
  });

  test('rejects unauthenticated socket missing both token and machineKey', async () => {
    const unauthSocket = { handshake: { auth: {} } };
    const next = jest.fn();

    await authMiddleware(unauthSocket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toContain('Missing token or machineKey');
  });

  test('rejects socket with invalid or tampered JWT token', async () => {
    const badTokenSocket = { handshake: { auth: { token: 'invalid.jwt.token' } } };
    const next = jest.fn();

    await authMiddleware(badTokenSocket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toContain('Authentication error');
  });

  test('non-superadmin admin joins strictly company room and NOT global admins or superadmins', () => {
    const franchiseeSocket = {
      id: 'socket-franchisee-1',
      userType: 'admin',
      userRole: 'FRANCHISEE',
      companyId: 'company-alpha',
      join: jest.fn(),
      on: jest.fn(),
      emit: jest.fn()
    };

    connectionHandler(franchiseeSocket);

    expect(franchiseeSocket.join).toHaveBeenCalledWith('company_company-alpha');
    expect(franchiseeSocket.join).not.toHaveBeenCalledWith('admins');
    expect(franchiseeSocket.join).not.toHaveBeenCalledWith('superadmins');
  });

  test('superadmin joins admins, superadmins, and company room when companyId is present', () => {
    const superadminSocket = {
      id: 'socket-superadmin-1',
      userType: 'admin',
      userRole: 'SUPERADMIN',
      companyId: 'company-platform',
      join: jest.fn(),
      on: jest.fn(),
      emit: jest.fn()
    };

    connectionHandler(superadminSocket);

    expect(superadminSocket.join).toHaveBeenCalledWith('admins');
    expect(superadminSocket.join).toHaveBeenCalledWith('superadmins');
    expect(superadminSocket.join).toHaveBeenCalledWith('company_company-platform');
  });

  test('superadmin without companyId joins admins and superadmins but no undefined company room', () => {
    const rootSuperadminSocket = {
      id: 'socket-superadmin-root',
      userType: 'admin',
      userRole: 'SUPERADMIN',
      companyId: null,
      join: jest.fn(),
      on: jest.fn(),
      emit: jest.fn()
    };

    connectionHandler(rootSuperadminSocket);

    expect(rootSuperadminSocket.join).toHaveBeenCalledWith('admins');
    expect(rootSuperadminSocket.join).toHaveBeenCalledWith('superadmins');
    expect(rootSuperadminSocket.join).not.toHaveBeenCalledWith(expect.stringContaining('company_'));
  });

  test('handlePrinterInventoryReport broadcasts only to company room and superadmins, never leaking to other tenants', async () => {
    const socket = {
      userType: 'printer',
      machineId: 'm-beta',
      agentProtocol: { supportsMultiPrinter: true },
      emit: jest.fn()
    };
    const io = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() })
    };
    const prisma = {
      machine: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'm-beta',
          companyId: 'company-beta'
        })
      },
      $transaction: jest.fn(async (cb) => cb({
        printerDiscovery: {
          upsert: jest.fn().mockResolvedValue({ id: 'disc-1' })
        }
      }))
    };

    const payload = {
      protocolVersion: 1,
      machineId: 'm-beta',
      requestId: 'inv-req-1',
      discoveredPrinters: [
        {
          windowsPrinterName: 'Epson L6460 Beta',
          driverName: 'Epson Driver',
          portName: 'USB001',
          connectionType: 'USB',
          isDefault: true,
          status: 'NORMAL'
        }
      ]
    };

    await handlePrinterInventoryReport({ socket, io, logger: { warn: jest.fn() }, prisma, payload });

    expect(io.to).toHaveBeenCalledWith('company_company-beta');
    expect(io.to).toHaveBeenCalledWith('superadmins');
    expect(io.to).not.toHaveBeenCalledWith('company_company-alpha');
    expect(io.to).not.toHaveBeenCalledWith('admins');
  });

  test('handlePrinterDeviceTelemetry broadcasts strictly to machine company room and superadmins', async () => {
    const socket = {
      userType: 'printer',
      machineId: 'm-gamma',
      agentProtocol: { supportsMultiPrinter: true },
      emit: jest.fn()
    };
    const io = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() })
    };
    const prisma = {
      printerDevice: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'dev-gamma-1',
          windowsPrinterName: 'HP LaserJet Gamma',
          machine: { companyId: 'company-gamma' }
        }),
        update: jest.fn().mockResolvedValue({ id: 'dev-gamma-1' })
      }
    };

    const status = {
      printerDeviceId: 'dev-gamma-1',
      printerName: 'HP LaserJet Gamma',
      connectionType: 'USB',
      isError: false,
      telemetry: {
        portName: 'USB001'
      }
    };

    await handlePrinterDeviceTelemetry({ socket, io, prisma, logger: { error: jest.fn() }, status });

    expect(io.to).toHaveBeenCalledWith('company_company-gamma');
    expect(io.to).toHaveBeenCalledWith('superadmins');
    expect(io.to).not.toHaveBeenCalledWith('company_company-alpha');
    expect(io.to).not.toHaveBeenCalledWith('company_company-beta');
    expect(io.to).not.toHaveBeenCalledWith('admins');
  });

  test('legacy printer_status_update event broadcasts strictly to company room and superadmins', async () => {
    let statusHandler = null;
    const printerSocket = {
      id: 'socket-printer-1',
      userType: 'printer',
      machineId: null,
      companyId: 'company-legacy-1',
      join: jest.fn(),
      on: jest.fn((event, handler) => {
        if (event === 'printer_status_update') {
          statusHandler = handler;
        }
      }),
      emit: jest.fn()
    };

    connectionHandler(printerSocket);
    expect(statusHandler).toBeDefined();

    const statusPayload = { isOnline: true, isError: false };
    await statusHandler(statusPayload);

    expect(mockIo.to).toHaveBeenCalledWith('company_company-legacy-1');
    expect(mockIo.to).toHaveBeenCalledWith('superadmins');
    expect(mockIo.to).not.toHaveBeenCalledWith('company_other_tenant');
    expect(mockIo.to).not.toHaveBeenCalledWith('admins');
  });
});
