const PrinterDispatchScheduler = require('../src/printerDispatchScheduler');

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

describe('PrinterDispatchScheduler', () => {
  test('preserves FIFO per device while allowing different devices to run concurrently', async () => {
    const scheduler = new PrinterDispatchScheduler({ maxConcurrent: 2 });
    const firstDeviceGate = deferred();
    const secondDeviceGate = deferred();
    const events = [];

    const first = scheduler.schedule('device-A', async () => {
      events.push('A1:start');
      await firstDeviceGate.promise;
      events.push('A1:end');
    });
    const second = scheduler.schedule('device-A', async () => {
      events.push('A2:start');
      events.push('A2:end');
    });
    const other = scheduler.schedule('device-B', async () => {
      events.push('B1:start');
      await secondDeviceGate.promise;
      events.push('B1:end');
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(events).toContain('A1:start');
    expect(events).toContain('B1:start');
    expect(events).not.toContain('A2:start');

    firstDeviceGate.resolve();
    await first;
    await Promise.resolve();
    await Promise.resolve();

    expect(events.indexOf('A1:end')).toBeLessThan(events.indexOf('A2:start'));

    secondDeviceGate.resolve();
    await Promise.all([second, other]);
    expect(events.indexOf('A2:start')).toBeGreaterThan(events.indexOf('A1:end'));
    expect(events).toContain('B1:end');
  });

  test('enforces the PC-wide concurrency ceiling and rejects unsafe limits', async () => {
    const scheduler = new PrinterDispatchScheduler({ maxConcurrent: 2 });
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let maximumObserved = 0;

    const jobs = gates.map((gate, index) => scheduler.schedule(`device-${index}`, async () => {
      active += 1;
      maximumObserved = Math.max(maximumObserved, active);
      await gate.promise;
      active -= 1;
    }));

    await Promise.resolve();
    await Promise.resolve();
    expect(maximumObserved).toBe(2);

    gates[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(maximumObserved).toBe(2);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(jobs);
    expect(maximumObserved).toBe(2);
    expect(() => new PrinterDispatchScheduler({ maxConcurrent: 6 })).toThrow(/between 1 and 5/);
  });

  test('rejects invalid device IDs and non-function tasks', async () => {
    const scheduler = new PrinterDispatchScheduler();
    await expect(scheduler.schedule('../device', async () => {})).rejects.toThrow(/valid PrinterDevice ID/);
    await expect(scheduler.schedule('device-A', null)).rejects.toThrow(/task function/);
  });
});
