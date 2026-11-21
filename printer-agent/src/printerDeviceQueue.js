class PrinterDeviceQueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrinterDeviceQueueError';
    this.code = code;
  }
}

/**
 * Serializes job preparation and spooler submission independently for each
 * physical PrinterDevice. Different devices run concurrently. A legacy
 * Machine-level queue uses its own lane and cannot overlap itself.
 */
class PrinterDeviceQueue {
  constructor() {
    this.tails = new Map();
    this.isDraining = false;
  }

  enqueue(laneKey, task) {
    if (this.isDraining) {
      throw new PrinterDeviceQueueError('QUEUE_SHUTTING_DOWN', 'Cannot accept work: Printer device queue is draining / shutting down.');
    }
    if (typeof laneKey !== 'string' || !laneKey.trim() || laneKey.length > 320) {
      throw new PrinterDeviceQueueError('INVALID_PRINTER_LANE', 'A valid printer lane key of at most 320 characters is required.');
    }
    if (typeof task !== 'function') {
      throw new PrinterDeviceQueueError('INVALID_PRINTER_TASK', 'A printer queue task function is required.');
    }

    const previous = this.tails.get(laneKey) || Promise.resolve();
    const current = previous.then(task, task);
    // The stored tail always resolves, so one failed job cannot poison the lane.
    const tail = current.then(() => undefined, () => undefined);
    this.tails.set(laneKey, tail);

    tail.then(() => {
      if (this.tails.get(laneKey) === tail) {
        this.tails.delete(laneKey);
      }
    });

    return current;
  }

  getActiveLaneCount() {
    return this.tails.size;
  }

  hasPending(laneKey) {
    return this.tails.has(laneKey);
  }

  /**
   * Gracefully drains all active lane tails within bounded timeout.
   * Disallows new work during and after drain.
   * @param {{ timeoutMs?: number }} options
   */
  async drain(options = {}) {
    this.isDraining = true;
    const timeoutMs = options.timeoutMs || 15000;

    if (this.tails.size === 0) {
      return { drained: true, activeLanes: 0 };
    }

    const activeTails = Array.from(this.tails.values());
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new PrinterDeviceQueueError('DRAIN_TIMEOUT', `Printer queue drain timed out after ${timeoutMs}ms with ${this.tails.size} active lanes remaining.`));
      }, timeoutMs);
    });

    try {
      await Promise.race([
        Promise.all(activeTails),
        timeoutPromise
      ]);
      return { drained: true, activeLanes: this.tails.size };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

module.exports = {
  PrinterDeviceQueue,
  PrinterDeviceQueueError
};
