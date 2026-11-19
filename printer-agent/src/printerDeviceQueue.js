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
  }

  enqueue(laneKey, task) {
    if (typeof laneKey !== 'string' || !laneKey.trim() || laneKey.length > 180) {
      throw new PrinterDeviceQueueError('INVALID_PRINTER_LANE', 'A valid printer lane key is required.');
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
}

module.exports = {
  PrinterDeviceQueue,
  PrinterDeviceQueueError
};
