const { PrinterDispatchAuthorizer } = require('../src/dispatchAuthorization');

function createSocket() {
  const handlers = new Map();
  return {
    handlers,
    emitted: [],
    on(event, callback) {
      handlers.set(event, callback);
    },
    emit(event, payload) {
      this.emitted.push({ event, payload });
    },
    receive(event, payload) {
      const handler = handlers.get(event);
      if (handler) handler(payload);
    }
  };
}

describe('PrinterDispatchAuthorizer', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('waits for a correlated positive backend authorization before resolving', async () => {
    const socket = createSocket();
    const authorizer = new PrinterDispatchAuthorizer(socket, {
      requestIdFactory: () => 'request-1'
    });

    const input = {
      jobId: 'JOB_DEVICE_001',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    };
    const pending = authorizer.authorize(input);

    expect(socket.emitted).toEqual([{
      event: 'printer_device_dispatch_authorization_request',
      payload: { requestId: 'request-1', ...input }
    }]);

    socket.receive('printer_device_dispatch_authorization_result', {
      requestId: 'request-1',
      allowed: true,
      machineId: 'machine-a',
      ...input
    });

    await expect(pending).resolves.toEqual(expect.objectContaining({ allowed: true }));
    authorizer.close();
  });

  test('rejects backend denial without proceeding to driver submission', async () => {
    const socket = createSocket();
    const authorizer = new PrinterDispatchAuthorizer(socket, {
      requestIdFactory: () => 'request-2'
    });
    const pending = authorizer.authorize({
      jobId: 'JOB_DEVICE_002',
      printerDeviceId: 'device-hp',
      windowsPrinterName: 'HP LaserJet'
    });

    socket.receive('printer_device_dispatch_authorization_result', {
      requestId: 'request-2',
      allowed: false,
      code: 'DEVICE_NOT_ACTIVE'
    });

    await expect(pending).rejects.toThrow('DEVICE_NOT_ACTIVE');
    authorizer.close();
  });

  test('rejects a positive response if its job/device/queue identity differs', async () => {
    const socket = createSocket();
    const authorizer = new PrinterDispatchAuthorizer(socket, {
      requestIdFactory: () => 'request-3'
    });
    const pending = authorizer.authorize({
      jobId: 'JOB_DEVICE_003',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    });

    socket.receive('printer_device_dispatch_authorization_result', {
      requestId: 'request-3',
      allowed: true,
      jobId: 'JOB_DEVICE_003',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'HP LaserJet',
      machineId: 'machine-a'
    });

    await expect(pending).rejects.toThrow('identity does not match');
    authorizer.close();
  });

  test('fails closed on authorization timeout and socket disconnect', async () => {
    jest.useFakeTimers();
    const timeoutSocket = createSocket();
    const timeoutAuthorizer = new PrinterDispatchAuthorizer(timeoutSocket, {
      timeoutMs: 100,
      requestIdFactory: () => 'request-timeout'
    });
    const timedOut = timeoutAuthorizer.authorize({
      jobId: 'JOB_DEVICE_004',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    });

    jest.advanceTimersByTime(101);
    await expect(timedOut).rejects.toThrow('timed out');
    timeoutAuthorizer.close();

    const disconnectSocket = createSocket();
    const disconnectAuthorizer = new PrinterDispatchAuthorizer(disconnectSocket, {
      requestIdFactory: () => 'request-disconnect'
    });
    const disconnected = disconnectAuthorizer.authorize({
      jobId: 'JOB_DEVICE_005',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    });
    disconnectSocket.receive('disconnect');
    await expect(disconnected).rejects.toThrow('disconnected');
    disconnectAuthorizer.close();
  });

  test('renews an active dispatch lease periodically and stops after driver handoff', () => {
    jest.useFakeTimers();
    const socket = createSocket();
    socket.connected = true;
    const authorizer = new PrinterDispatchAuthorizer(socket);
    const input = {
      jobId: 'JOB_DEVICE_006',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    };
    const stopRenewal = authorizer.startLeaseRenewal({ requestId: 'request-lease' }, input, 1000);

    jest.advanceTimersByTime(2500);
    expect(socket.emitted.filter((entry) =>
      entry.event === 'printer_device_dispatch_lease_renewal'
    )).toHaveLength(2);

    stopRenewal();
    jest.advanceTimersByTime(3000);
    expect(socket.emitted.filter((entry) =>
      entry.event === 'printer_device_dispatch_lease_renewal'
    )).toHaveLength(2);

    expect(authorizer.releaseLease({ requestId: 'request-lease' }, input)).toBe(true);
    expect(socket.emitted.at(-1)).toEqual({
      event: 'printer_device_dispatch_lease_release',
      payload: {
        requestId: 'request-lease',
        ...input
      }
    });
    authorizer.close();
  });

  test('does not send lease renewal or release while disconnected', () => {
    const socket = createSocket();
    socket.connected = false;
    const authorizer = new PrinterDispatchAuthorizer(socket);
    const input = {
      jobId: 'JOB_DEVICE_007',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    };

    const stopRenewal = authorizer.startLeaseRenewal({ requestId: 'request-disconnected' }, input, 1000);
    expect(authorizer.releaseLease({ requestId: 'request-disconnected' }, input)).toBe(false);
    expect(socket.emitted).toHaveLength(0);
    stopRenewal();
    authorizer.close();
  });

  test('rejects malformed requests without emitting anything', async () => {
    const socket = createSocket();
    const authorizer = new PrinterDispatchAuthorizer(socket);
    await expect(authorizer.authorize({
      jobId: '../bad',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    })).rejects.toThrow('invalid');
    expect(socket.emitted).toHaveLength(0);
    authorizer.close();
  });
});
