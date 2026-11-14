'use strict';

/**
 * P1-01: Physical Print Serialization Mutex
 *
 * Implements a promise-chain mutex that serializes all physical print dispatches
 * for a single printer. Because Node.js is single-threaded, all accesses to
 * this module's shared state are atomic at the JS event-loop level, so there
 * are no additional synchronization primitives required beyond Promise chaining.
 *
 * Lock lifecycle:
 *   - acquire()  → returns a release function; caller MUST call it on a
 *                  verified terminal outcome only.
 *   - lockForAmbiguous() → permanently locks without a release handle;
 *                          used when physical outcome is uncertain.
 *   - isLocked() → observable state for diagnostics / reconciliation guards.
 *   - getHeldJobId() → jobId currently holding the lock (or null).
 *
 * Design invariants:
 *   1. Each acquire() call enqueues behind all prior callers via promise chain.
 *   2. Release is ONLY triggered by calling the returned releaseFn.
 *      An ambiguous job NEVER calls releaseFn.
 *   3. lockForAmbiguous() replaces the chain tail with a never-resolving
 *      promise so no future job can acquire the lock.
 *   4. The lock state survives reconnect/reconciliation events (module singleton).
 */
class PrintMutex {
  constructor() {
    // The chain tail: each new acquire appends to this promise.
    // Starts resolved so the first caller proceeds immediately.
    this._chain = Promise.resolve();
    this._locked = false;
    this._heldJobId = null;
  }

  /**
   * Acquire the mutex for the given jobId.
   * Returns a Promise that resolves to a { release } object when the lock is
   * granted. The caller MUST call release() after verified terminal success or
   * failure. On ambiguous outcome, call lockForAmbiguous() instead.
   *
   * @param {string} jobId
   * @returns {Promise<{ release: function }>}
   */
  acquire(jobId) {
    let resolveCurrent;
    // Create a promise that will block the next waiter until we call resolveCurrent
    const lockPromise = new Promise(resolve => { resolveCurrent = resolve; });

    // Append to chain: when previous chain tail resolves, grant this caller
    const waitPromise = this._chain.then(() => {
      this._locked = true;
      this._heldJobId = jobId;
      return { release: () => this._release(resolveCurrent) };
    });

    // Update chain tail to the newly queued promise
    // The next caller will wait for lockPromise (not waitPromise) so our
    // "grant" does not unblock the successor until release() is called.
    this._chain = lockPromise;

    return waitPromise;
  }

  /**
   * Permanently lock the mutex without providing a release handle.
   * Used when a job outcome is ambiguous and no further physical printing
   * must be permitted without operator intervention.
   * Sets the chain tail to a never-resolving promise.
   *
   * Safe to call even if the lock is already acquired by this job.
   *
   * @param {string} jobId
   */
  lockForAmbiguous(jobId) {
    this._locked = true;
    this._heldJobId = jobId ? `AMBIGUOUS:${jobId}` : 'AMBIGUOUS:unknown';
    // Replace the chain with a promise that never resolves.
    // Any job waiting via acquire() will remain indefinitely queued.
    this._chain = new Promise(() => {}); // Never resolves
  }

  /**
   * @returns {boolean}
   */
  isLocked() {
    return this._locked;
  }

  /**
   * @returns {string|null}
   */
  getHeldJobId() {
    return this._heldJobId;
  }

  /**
   * @private
   */
  _release(resolveCurrent) {
    this._locked = false;
    this._heldJobId = null;
    resolveCurrent(); // Unblocks the next waiting acquire()
  }
}

// Module-level singleton — shared across all requires within this process.
// All physical_print_job event handlers and reconciliation handlers therefore
// share the exact same lock instance.
const singleton = new PrintMutex();

module.exports = singleton;
module.exports.PrintMutex = PrintMutex; // Export class for unit testing
