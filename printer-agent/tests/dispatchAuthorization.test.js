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

  test('handles correlated renewal acknowledgement and tracks success or rejection', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-19T09:59:50Z'));
    const socket = createSocket();
    socket.connected = true;
    const authorizer = new PrinterDispatchAuthorizer(socket);
    const input = {
      jobId: 'JOB_DEVICE_006B',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    };
    const stopRenewal = authorizer.startLeaseRenewal({ requestId: 'req-corr-1', leaseExpiresAt: '2026-11-19T10:00:00Z' }, input, 1000);

    // Initial state
    const state = authorizer.activeRenewals.get('req-corr-1');
    expect(state).toBeDefined();
    expect(state.renewed).toBe(true);

    // Receive positive acknowledgement
    socket.receive('printer_device_dispatch_lease_renewal_result', {
      requestId: 'req-corr-1',
      jobId: 'JOB_DEVICE_006B',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460',
      renewed: true,
      leaseId: 'lease-123',
      expiresAt: '2026-11-19T10:02:00Z'
    });

    expect(state.renewed).toBe(true);
    expect(state.leaseId).toBe('lease-123');
    expect(state.lastExpiresAt).toBe('2026-11-19T10:02:00Z');

    // Duplicate ACK processes idempotently without state corruption
    socket.receive('printer_device_dispatch_lease_renewal_result', {
      requestId: 'req-corr-1',
      jobId: 'JOB_DEVICE_006B',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460',
      renewed: true,
      leaseId: 'lease-123',
      expiresAt: '2026-11-19T10:02:00Z'
    });
    expect(state.renewed).toBe(true);
    expect(state.leaseId).toBe('lease-123');

    // Receive rejection acknowledgement
    socket.receive('printer_device_dispatch_lease_renewal_result', {
      requestId: 'req-corr-1',
      jobId: 'JOB_DEVICE_006B',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460',
      renewed: false,
      code: 'DISPATCH_LEASE_NOT_ACTIVE'
    });

    expect(state.renewed).toBe(false);
    expect(state.lastError).toBe('DISPATCH_LEASE_NOT_ACTIVE');

    // Receive mismatched identity (wrong job ID)
    socket.receive('printer_device_dispatch_lease_renewal_result', {
      requestId: 'req-corr-1',
      jobId: 'DIFFERENT_JOB',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460',
      renewed: true
    });
    expect(state.lastError).toBe('IDENTITY_MISMATCH');

    // Receive mismatched identity (wrong lease ID)
    socket.receive('printer_device_dispatch_lease_renewal_result', {
      requestId: 'req-corr-1',
      jobId: 'JOB_DEVICE_006B',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460',
      leaseId: 'wrong-lease-id',
      renewed: true
    });
    expect(state.lastError).toBe('IDENTITY_MISMATCH');

    stopRenewal();
    expect(authorizer.activeRenewals.has('req-corr-1')).toBe(false);
    authorizer.close();
  });

  test('missing renewal ACK never extends expiresAt and keeps lastAckAt null', () => {
    jest.useFakeTimers();
    const socket = createSocket();
    socket.connected = true;
    const authorizer = new PrinterDispatchAuthorizer(socket);
    const input = {
      jobId: 'JOB_DEVICE_MISSING_ACK',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    };
    const initialExpiry = '2026-11-19T10:00:30Z';
    const stopRenewal = authorizer.startLeaseRenewal({ requestId: 'req-missing-ack', leaseExpiresAt: initialExpiry }, input, 5000);

    const state = authorizer.activeRenewals.get('req-missing-ack');
    expect(state.lastExpiresAt).toBe(initialExpiry);
    expect(state.lastAckAt).toBeNull();

    // Advance timers past renewal interval - emit happens but no ACK returns from backend
    jest.advanceTimersByTime(12000);
    expect(socket.emitted.filter(e => e.event === 'printer_device_dispatch_lease_renewal')).toHaveLength(2);

    // Without incoming ACK, lastExpiresAt MUST NOT be extended
    expect(state.lastExpiresAt).toBe(initialExpiry);
    expect(state.lastAckAt).toBeNull();

    stopRenewal();
    authorizer.close();
  });

  test('delayed ACK cannot revive an already released lease', () => {
    jest.useFakeTimers();
    const socket = createSocket();
    socket.connected = true;
    const authorizer = new PrinterDispatchAuthorizer(socket);
    const input = {
      jobId: 'JOB_DEVICE_DELAYED',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    };
    authorizer.startLeaseRenewal({ requestId: 'req-delayed', leaseExpiresAt: '2026-11-19T10:00:30Z' }, input, 5000);

    expect(authorizer.activeRenewals.has('req-delayed')).toBe(true);

    // Job finishes and agent explicitly releases the lease
    const released = authorizer.releaseLease({ requestId: 'req-delayed' }, input);
    expect(released).toBe(true);
    expect(authorizer.activeRenewals.has('req-delayed')).toBe(false);

    // Delayed ACK arrives after lease was released
    socket.receive('printer_device_dispatch_lease_renewal_result', {
      requestId: 'req-delayed',
      jobId: 'JOB_DEVICE_DELAYED',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460',
      renewed: true,
      leaseId: 'lease-delayed',
      expiresAt: '2026-11-19T10:05:00Z'
    });

    // Active renewals must NOT be revived
    expect(authorizer.activeRenewals.has('req-delayed')).toBe(false);
    authorizer.close();
  });

  test('delayed ACK arriving beyond lease expiry without lease release is rejected and cannot extend expired lease', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-19T10:00:00Z'));
    const socket = createSocket();
    socket.connected = true;
    const authorizer = new PrinterDispatchAuthorizer(socket);
    const input = {
      jobId: 'JOB_DEVICE_EXPIRED_ACK',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460'
    };
    const initialExpiry = '2026-11-19T10:00:30Z';
    const stopRenewal = authorizer.startLeaseRenewal({ requestId: 'req-expired-ack', leaseExpiresAt: initialExpiry }, input, 10000);

    const state = authorizer.activeRenewals.get('req-expired-ack');
    expect(state.lastExpiresAt).toBe(initialExpiry);

    // Advance clock past the lease expiration time without releasing the lease
    jest.advanceTimersByTime(40000); // Now 10:00:40Z, 10s past expiry

    // Delayed positive ACK arrives late after lease already expired
    socket.receive('printer_device_dispatch_lease_renewal_result', {
      requestId: 'req-expired-ack',
      jobId: 'JOB_DEVICE_EXPIRED_ACK',
      printerDeviceId: 'device-epson',
      windowsPrinterName: 'Epson L6460',
      renewed: true,
      leaseId: 'lease-late',
      expiresAt: '2026-11-19T10:05:00Z'
    });

    // Must NOT extend the expired lease, must mark renewed = false and LEASE_EXPIRED
    expect(state.renewed).toBe(false);
    expect(state.lastError).toBe('LEASE_EXPIRED');
    expect(state.lastExpiresAt).toBe(initialExpiry); // Unchanged

    stopRenewal();
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
