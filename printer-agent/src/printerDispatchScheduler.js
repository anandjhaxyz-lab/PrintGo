const DEFAULT_MAX_CONCURRENT_PRINTS = 5;
const MAX_ALLOWED_CONCURRENT_PRINTS = 5;
const MAX_QUEUED_PER_DEVICE = 100;

class PrinterDispatchScheduler {
  constructor(options = {}) {
    const maxConcurrent = options.maxConcurrent === undefined
      ? DEFAULT_MAX_CONCURRENT_PRINTS
      : options.maxConcurrent;

    if (
      !Number.isInteger(maxConcurrent) ||
      maxConcurrent < 1 ||
      maxConcurrent > MAX_ALLOWED_CONCURRENT_PRINTS
    ) {
      throw new Error(`maxConcurrent must be an integer between 1 and ${MAX_ALLOWED_CONCURRENT_PRINTS}.`);
    }

    this.maxConcurrent = maxConcurrent;
    this.activeCount = 0;
    this.activeDevices = new Set();
    this.queues = new Map();
    this.roundRobin = [];
  }

  schedule(printerDeviceId, task) {
    if (
      typeof printerDeviceId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(printerDeviceId)
    ) {
      return Promise.reject(new Error('A valid PrinterDevice ID is required for scheduled dispatch.'));
    }
    if (typeof task !== 'function') {
      return Promise.reject(new Error('A dispatch task function is required.'));
    }

    return new Promise((resolve, reject) => {
      let queue = this.queues.get(printerDeviceId);
      if (!queue) {
        queue = [];
        this.queues.set(printerDeviceId, queue);
        this.roundRobin.push(printerDeviceId);
      }

      if (queue.length >= MAX_QUEUED_PER_DEVICE) {
        reject(new Error(`PrinterDevice ${printerDeviceId} has reached its pending dispatch limit.`));
        return;
      }

      queue.push({ task, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.activeCount < this.maxConcurrent && this.roundRobin.length > 0) {
      const scanCount = this.roundRobin.length;
      let started = false;

      for (let index = 0; index < scanCount; index += 1) {
        const printerDeviceId = this.roundRobin.shift();
        const queue = this.queues.get(printerDeviceId);

        if (!queue || queue.length === 0) {
          this.queues.delete(printerDeviceId);
          continue;
        }

        // A PrinterDevice may have only one active physical dispatch at a time.
        if (this.activeDevices.has(printerDeviceId)) {
          this.roundRobin.push(printerDeviceId);
          continue;
        }

        const entry = queue.shift();
        this.activeDevices.add(printerDeviceId);
        this.activeCount += 1;

        if (queue.length > 0) {
          this.roundRobin.push(printerDeviceId);
        } else {
          this.queues.delete(printerDeviceId);
        }

        Promise.resolve()
          .then(() => entry.task())
          .then(entry.resolve, entry.reject)
          .finally(() => {
            this.activeCount -= 1;
            this.activeDevices.delete(printerDeviceId);

            const remaining = this.queues.get(printerDeviceId);
            if (remaining && remaining.length > 0 && !this.roundRobin.includes(printerDeviceId)) {
              this.roundRobin.push(printerDeviceId);
            }

            this.pump();
          });

        started = true;
        break;
      }

      // All queued devices are already running; wait for one to finish.
      if (!started) break;
    }
  }
}

module.exports = PrinterDispatchScheduler;
