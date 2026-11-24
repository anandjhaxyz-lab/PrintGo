const { PrinterDeviceQueue } = require('../src/printerDeviceQueue');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('PrinterDeviceQueue', () => {
  test('preserves FIFO submission order within one physical printer lane', async () => {
    const queue = new PrinterDeviceQueue();
    const firstGate = deferred();
    const order = [];

    const first = queue.enqueue('device:epson', async () => {
      order.push('first:start');
      await firstGate.promise;
      order.push('first:end');
    });
    const second = queue.enqueue('device:epson', async () => {
      order.push('second:start');
      order.push('second:end');
    });
    const third = queue.enqueue('device:epson', async () => {
      order.push('third:start');
      order.push('third:end');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);

    firstGate.resolve();
    await Promise.all([first, second, third]);

    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
      'third:start',
      'third:end'
    ]);
  });

  test('allows different physical printers to run concurrently', async () => {
    const queue = new PrinterDeviceQueue();
    const gateA = deferred();
    const gateB = deferred();
    const started = [];

    const jobA = queue.enqueue('device:epson', async () => {
      started.push('epson');
      await gateA.promise;
    });
    const jobB = queue.enqueue('device:hp', async () => {
      started.push('hp');
      await gateB.promise;
    });

    await Promise.resolve();
    expect(started).toEqual(['epson', 'hp']);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([jobA, jobB]);
  });

  test('a failed job does not block later jobs on the same printer', async () => {
    const queue = new PrinterDeviceQueue();
    const order = [];

    const failed = queue.enqueue('device:epson', async () => {
      order.push('failed');
      throw new Error('driver rejected document');
    });
    const next = queue.enqueue('device:epson', async () => {
      order.push('next');
      return 'accepted';
    });

    await expect(failed).rejects.toThrow('driver rejected document');
    await expect(next).resolves.toBe('accepted');
    expect(order).toEqual(['failed', 'next']);
    expect(queue.hasPending('device:epson')).toBe(false);
  });

  test('isolates the legacy Machine queue from child PrinterDevice lanes', async () => {
    const queue = new PrinterDeviceQueue();
    const gate = deferred();
    const order = [];

    const legacy = queue.enqueue('legacy:machine-a', async () => {
      order.push('legacy:start');
      await gate.promise;
      order.push('legacy:end');
    });
    const device = queue.enqueue('device:printer-1', async () => {
      order.push('device:start');
      order.push('device:end');
    });

    await device;
    expect(order).toEqual(['legacy:start', 'device:start', 'device:end']);

    gate.resolve();
    await legacy;
    expect(order).toEqual(['legacy:start', 'device:start', 'device:end', 'legacy:end']);
  });

  test('accepts the maximum supported Windows queue-name lane length', async () => {
    const queue = new PrinterDeviceQueue();
    const laneKey = `queue:${'Q'.repeat(256)}`;
    await expect(queue.enqueue(laneKey, async () => 'ok')).resolves.toBe('ok');
  });

  test('rejects invalid lane keys and non-function tasks', () => {
    const queue = new PrinterDeviceQueue();
    const expectErrorCode = (operation, code) => {
      let thrown;
      try {
        operation();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect(thrown.code).toBe(code);
    };

    expectErrorCode(() => queue.enqueue('', () => {}), 'INVALID_PRINTER_LANE');
    expectErrorCode(() => queue.enqueue('Q'.repeat(321), () => {}), 'INVALID_PRINTER_LANE');
    expectErrorCode(() => queue.enqueue('device:a', null), 'INVALID_PRINTER_TASK');
  });
});
