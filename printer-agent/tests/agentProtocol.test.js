const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readInstallationId,
  buildAgentHello,
  validatePrinterDeviceRegistry
} = require('../src/agentProtocol');

describe('Printer Agent protocol helpers', () => {
  test('advertises multi-printer support only on Windows x64 (OS compatibility matrix)', () => {
    // Windows 10 x64: accepted
    const win10 = buildAgentHello({ platform: 'win32', arch: 'x64', release: '10.0.19045', agentVersion: '1.0.0' });
    expect(win10.capabilities.multiPrinter).toBe(true);
    expect(win10.capabilities.printerDiscovery).toBe(true);
    expect(win10.capabilities.maxPrinters).toBe(10);

    // Windows 11 x64: accepted
    const win11 = buildAgentHello({ platform: 'win32', arch: 'x64', release: '10.0.22631', agentVersion: '1.0.0' });
    expect(win11.capabilities.multiPrinter).toBe(true);
    expect(win11.capabilities.printerDiscovery).toBe(true);
    expect(win11.capabilities.maxPrinters).toBe(10);

    // Windows 8.1 x64 (NT 6.3): rejected
    const win81 = buildAgentHello({ platform: 'win32', arch: 'x64', release: '6.3.9600' });
    expect(win81.capabilities.multiPrinter).toBe(false);
    expect(win81.capabilities.printerDiscovery).toBe(false);
    expect(win81.capabilities.maxPrinters).toBe(1);

    // Windows 10 ARM64: rejected
    const win10Arm = buildAgentHello({ platform: 'win32', arch: 'arm64', release: '10.0.19045' });
    expect(win10Arm.capabilities.multiPrinter).toBe(false);
    expect(win10Arm.capabilities.printerDiscovery).toBe(false);
    expect(win10Arm.capabilities.maxPrinters).toBe(1);

    // Linux x64: rejected
    const linux = buildAgentHello({ platform: 'linux', arch: 'x64', release: '6.8.0' });
    expect(linux.capabilities.multiPrinter).toBe(false);
    expect(linux.capabilities.printerDiscovery).toBe(false);
    expect(linux.capabilities.maxPrinters).toBe(1);
  });

  test('reads an existing installation ID without modifying the marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printgo-agent-protocol-'));
    const markerPath = path.join(dir, '.installation_marker');
    const raw = JSON.stringify({ installationId: 'stable-install-id', schemaVersion: 1 });
    try {
      fs.writeFileSync(markerPath, raw);
      expect(readInstallationId(markerPath)).toBe('stable-install-id');
      expect(fs.readFileSync(markerPath, 'utf8')).toBe(raw);
      expect(buildAgentHello({
        markerPath,
        platform: 'win32',
        arch: 'x64'
      }).installationId).toBe('stable-install-id');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('validates a machine-bound registry and preserves approval state', () => {
    const result = validatePrinterDeviceRegistry({
      protocolVersion: 1,
      machineId: 'machine-a',
      devices: [{
        id: 'device-1',
        displayName: 'Epson Counter',
        windowsPrinterName: 'EPSON L6460 Series',
        status: 'ACTIVE',
        approvedAt: '2026-11-19T00:00:00.000Z',
        sortOrder: 1
      }]
    }, 'machine-a');

    expect(result).toEqual([expect.objectContaining({
      id: 'device-1',
      windowsPrinterName: 'EPSON L6460 Series',
      status: 'ACTIVE',
      approvedAt: '2026-11-19T00:00:00.000Z'
    })]);
  });

  test('rejects a registry for another machine and unsupported protocol', () => {
    expect(() => validatePrinterDeviceRegistry({
      protocolVersion: 1, machineId: 'machine-b', devices: []
    }, 'machine-a')).toThrow(expect.objectContaining({ code: 'MACHINE_ID_MISMATCH' }));

    expect(() => validatePrinterDeviceRegistry({
      protocolVersion: 2, machineId: 'machine-a', devices: []
    }, 'machine-a')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REGISTRY_PROTOCOL' }));
  });

  test('rejects malformed, duplicate, or oversized device mappings', () => {
    expect(() => validatePrinterDeviceRegistry({
      protocolVersion: 1, machineId: 'machine-a', devices: [{ id: 'd1', windowsPrinterName: '', status: 'ACTIVE' }]
    }, 'machine-a')).toThrow(expect.objectContaining({ code: 'INVALID_QUEUE_NAME' }));

    expect(() => validatePrinterDeviceRegistry({
      protocolVersion: 1,
      machineId: 'machine-a',
      devices: [
        { id: 'd1', windowsPrinterName: 'Queue A', status: 'ACTIVE' },
        { id: 'd2', windowsPrinterName: 'queue a', status: 'ACTIVE' }
      ]
    }, 'machine-a')).toThrow(expect.objectContaining({ code: 'DUPLICATE_DEVICE_BINDING' }));

    expect(() => validatePrinterDeviceRegistry({
      protocolVersion: 1,
      machineId: 'machine-a',
      devices: Array.from({ length: 11 }, (_, i) => ({
        id: `d${i}`, windowsPrinterName: `Queue ${i}`, status: 'PENDING_APPROVAL'
      }))
    }, 'machine-a')).toThrow(expect.objectContaining({ code: 'INVALID_REGISTRY_COUNT' }));
  });
});
