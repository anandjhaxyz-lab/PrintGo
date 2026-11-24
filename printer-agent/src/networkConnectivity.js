const net = require('net');

/**
 * Parses a Windows printer portName into a TCP host and port endpoint.
 *
 * Supported formats:
 * - IPv4: "192.168.1.7" -> { host: "192.168.1.7", port: 9100 }
 * - IPv4 with port: "192.168.1.7:9100" -> { host: "192.168.1.7", port: 9100 }
 * - Prefix IP_: "IP_192.168.1.7" -> { host: "192.168.1.7", port: 9100 }
 * - Prefix TCP_: "TCP_192.168.1.7:9100" -> { host: "192.168.1.7", port: 9100 }
 * - URI style: "socket://192.168.1.7:9100", "raw://192.168.1.7" -> host and port
 * - Hostnames: "printer-frontdesk:9100" -> { host: "printer-frontdesk", port: 9100 }
 *
 * Unsupported / Malformed formats (returns null):
 * - USB ports (e.g. "USB001", "USB019")
 * - WSD ports without explicit TCP host/port (e.g. "WSD-xxxx")
 * - Empty, non-string, or malformed strings
 *
 * @param {string} portName
 * @returns {{ host: string, port: number } | null}
 */
function parseTcpEndpoint(portName) {
  if (!portName || typeof portName !== 'string') return null;
  let raw = portName.trim();
  if (!raw) return null;

  // 1. Filter out USB or pure local ports
  if (/^USB/i.test(raw) || /^COM\d+/i.test(raw) || /^LPT\d+/i.test(raw)) {
    return null;
  }

  // 2. Filter out WSD ports without explicit IP
  if (/^WSD[-_]/i.test(raw)) {
    return null;
  }

  // 3. Strip scheme prefixes: socket://, raw://, tcp://
  raw = raw.replace(/^(socket|raw|tcp):\/\//i, '');

  // 4. Strip standard Windows Standard TCP/IP port prefixes: IP_, TCP_, NET_
  raw = raw.replace(/^(IP_|TCP_|NET_)/i, '');

  // 5. Match host and optional port
  // IPv4 or hostname
  const hostPortMatch = raw.match(/^([a-zA-Z0-9.-]+)(?::(\d{1,5}))?$/);
  if (!hostPortMatch) return null;

  const host = hostPortMatch[1].trim();
  const rawPort = hostPortMatch[2];
  const port = rawPort ? parseInt(rawPort, 10) : 9100;

  // Validate port range
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  // Validate host: must look like an IPv4 address or a valid hostname
  const isIpv4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host);
  const isHostname = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host);

  if (isIpv4) {
    const octets = host.split('.').map(o => parseInt(o, 10));
    if (octets.some(o => o < 0 || o > 255)) return null;
    return { host, port };
  }

  if (isHostname) {
    return { host, port };
  }

  return null;
}

/**
 * Performs a bounded, non-destructive TCP connectivity probe to a network printer endpoint.
 *
 * Safety properties:
 * - Opens a transient socket with strict timeout.
 * - NEVER sends print data or test jobs.
 * - NEVER establishes persistent or leased sockets.
 * - Immediately destroys the socket upon connect, error, or timeout.
 * - Fully mockable via optional netModule injection.
 *
 * @param {Object} options
 * @param {string} options.host - Destination IP or hostname
 * @param {number} [options.port=9100] - Destination port (default 9100)
 * @param {number} [options.timeoutMs=2000] - Bounded timeout in milliseconds
 * @param {Object} [options.netModule=net] - Injected net module for unit testing
 * @returns {Promise<{ isOnline: boolean, error: string | null }>}
 */
function checkTcpConnectivity(options = {}) {
  const {
    host,
    port = 9100,
    timeoutMs = 2000,
    netModule = net
  } = options;

  return new Promise((resolve) => {
    if (!host || typeof host !== 'string') {
      return resolve({ isOnline: false, error: 'INVALID_HOST' });
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return resolve({ isOnline: false, error: 'INVALID_PORT' });
    }

    let settled = false;
    let socket;

    try {
      socket = new netModule.Socket();
    } catch (err) {
      return resolve({ isOnline: false, error: err?.code || err?.message || 'SOCKET_INIT_FAILED' });
    }

    const finish = (isOnline, error = null) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (_) {}
      resolve({ isOnline, error });
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => finish(true, null));
    socket.once('timeout', () => finish(false, 'TIMED_OUT'));
    socket.once('error', (err) => finish(false, err?.code || err?.message || 'CONNECT_FAILED'));

    try {
      socket.connect(port, host);
    } catch (err) {
      finish(false, err?.code || err?.message || 'CONNECT_EXCEPTION');
    }
  });
}

module.exports = {
  parseTcpEndpoint,
  checkTcpConnectivity
};
