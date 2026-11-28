const { EventEmitter } = require('events');
const { parseTcpEndpoint, checkTcpConnectivity } = require('../src/networkConnectivity');

describe('networkConnectivity', () => {
  test.each([
    ['192.168.1.7', { host: '192.168.1.7', port: 9100 }],
    ['IP_192.168.1.7', { host: '192.168.1.7', port: 9100 }],
    ['TCP_192.168.1.7:9200', { host: '192.168.1.7', port: 9200 }],
    ['socket://printer.local:9100', { host: 'printer.local', port: 9100 }]
  ])('parses %s into a bounded TCP endpoint', (portName, expected) => {
    expect(parseTcpEndpoint(portName)).toEqual(expected);
  });

  test.each(['USB001', 'USB019', 'WSD-1234', '', null, '192.168.1.7:99999', 'not a port'])('rejects unsupported or malformed endpoint %s', (portName) => {
    expect(parseTcpEndpoint(portName)).toBeNull();
  });

  test('confirms TCP connection and destroys the transient socket without sending payload', async () => {
    let socket;
    class MockSocket extends EventEmitter {
      setTimeout = jest.fn();
      destroy = jest.fn();
      connect = jest.fn(() => queueMicrotask(() => this.emit('connect')));
      write = jest.fn();
      constructor() { super(); socket = this; }
    }
    const result = await checkTcpConnectivity({ host: '192.168.1.7', port: 9100, netModule: { Socket: MockSocket } });
    expect(result).toEqual({ isOnline: true, error: null });
    expect(socket.connect).toHaveBeenCalledWith(9100, '192.168.1.7');
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(socket.write).not.toHaveBeenCalled();
  });

  test('reports connection errors and closes the socket', async () => {
    let socket;
    class MockSocket extends EventEmitter {
      setTimeout = jest.fn();
      destroy = jest.fn();
      connect = jest.fn(() => queueMicrotask(() => this.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))));
      constructor() { super(); socket = this; }
    }
    const result = await checkTcpConnectivity({ host: '192.168.1.7', port: 9100, netModule: { Socket: MockSocket } });
    expect(result).toEqual({ isOnline: false, error: 'ECONNREFUSED' });
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
});
