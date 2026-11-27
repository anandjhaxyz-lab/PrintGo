jest.mock('../src/utils/prisma', () => ({}));
jest.mock('../src/services/printerAvailability.service', () => ({
  getMachineAvailability: jest.fn().mockResolvedValue({ status: 'ONLINE', isReady: true }),
  getPrinterDeviceAvailability: jest.fn().mockImplementation(async (machineId, printerDeviceId) => ({
    machineId, printerDeviceId, status: 'ONLINE', isReady: true
  })),
  computePrinterAvailability: jest.fn()
}));
jest.mock('../src/services/printerAgentProtocol.service', () => ({
  handlePrinterAgentHello: jest.fn(),
  handlePrinterDeviceRegistryRequest: jest.fn(),
  handlePrinterInventoryReport: jest.fn(),
  handlePrinterDeviceTelemetry: jest.fn()
}));
jest.mock('../src/services/printerDeviceJobBinding.service', () => ({
  verifyPrinterDeviceReport: jest.fn(),
  authorizePrinterDeviceDispatch: jest.fn(),
  renewPrinterDeviceDispatchLease: jest.fn(),
  releasePrinterDeviceDispatchLease: jest.fn()
}));

const jwt = require('jsonwebtoken');
const setupSockets = require('../src/socket');
const {
  getMachineAvailability,
  getPrinterDeviceAvailability
} = require('../src/services/printerAvailability.service');

const makeSocket = (token) => ({
  id: Math.random().toString(16).slice(2),
  handshake: { auth: { token } },
  join: jest.fn(),
  emit: jest.fn(),
  on: jest.fn()
});

const connect = async (io, middleware, handler, socket) => {
  await new Promise((resolve, reject) => middleware(socket, (error) => error ? reject(error) : resolve()));
  handler(socket);
  await Promise.resolve();
};

describe('Dedicated printer socket isolation', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = 'isolated-test-secret';
  });

  test('three QR sessions join only their own device rooms; legacy session keeps machine room', async () => {
    let middleware;
    let connectionHandler;
    const io = {
      use: jest.fn((fn) => { middleware = fn; }),
      on: jest.fn((event, fn) => { if (event === 'connection') connectionHandler = fn; }),
      to: jest.fn(() => ({ emit: jest.fn() }))
    };
    setupSockets(io);

    const deviceIds = ['epson-device', 'hp-device', 'canon-device'];
    const sockets = [];
    for (const printerDeviceId of deviceIds) {
      const token = jwt.sign({
        type: 'session',
        sessionId: 'session-' + printerDeviceId,
        machineId: 'machine-main',
        printerDeviceId
      }, process.env.JWT_SECRET);
      const socket = makeSocket(token);
      await connect(io, middleware, connectionHandler, socket);
      sockets.push(socket);
    }

    for (let index = 0; index < sockets.length; index += 1) {
      expect(sockets[index].join).toHaveBeenCalledWith('printer_device_' + deviceIds[index]);
      expect(sockets[index].join).not.toHaveBeenCalledWith('machine_machine-main');
      expect(sockets[index].printerDeviceId).toBe(deviceIds[index]);
    }

    expect(getPrinterDeviceAvailability).toHaveBeenCalledTimes(3);
    expect(getPrinterDeviceAvailability.mock.calls.map((call) => call[1])).toEqual(deviceIds);
    expect(getMachineAvailability).not.toHaveBeenCalled();

    const legacyToken = jwt.sign({
      type: 'session',
      sessionId: 'legacy-session',
      machineId: 'machine-main'
    }, process.env.JWT_SECRET);
    const legacySocket = makeSocket(legacyToken);
    await connect(io, middleware, connectionHandler, legacySocket);

    expect(legacySocket.join).toHaveBeenCalledWith('machine_machine-main');
    expect(legacySocket.join).not.toHaveBeenCalledWith('printer_device_undefined');
    expect(getMachineAvailability).toHaveBeenCalledTimes(1);
  });
});
