const crypto = require('crypto');

class PrinterDispatchAuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrinterDispatchAuthorizationError';
    this.code = code;
  }
}

/**
 * Obtains a fresh, job-specific backend decision immediately before the Agent
 * writes durable dispatch intent and calls the local Windows print driver.
 * Any denial, timeout, disconnect or identity mismatch must block submission.
 */
class PrinterDispatchAuthorizer {
  constructor(socket, options = {}) {
    if (!socket || typeof socket.on !== 'function' || typeof socket.emit !== 'function') {
      throw new PrinterDispatchAuthorizationError(
        'INVALID_SOCKET',
        'An authenticated Socket.IO client is required for dispatch authorization.'
      );
    }
    this.socket = socket;
    this.timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 10000;
    this.requestIdFactory = typeof options.requestIdFactory === 'function'
      ? options.requestIdFactory
      : () => crypto.randomUUID();
    this.pending = new Map();
    this.closed = false;

    this.onResult = (payload) => this.handleResult(payload);
    this.onDisconnect = () => this.rejectAll('Agent disconnected during dispatch authorization.');
    socket.on('printer_device_dispatch_authorization_result', this.onResult);
    socket.on('disconnect', this.onDisconnect);
  }

  authorize(input = {}) {
    if (this.closed) {
      return Promise.reject(new PrinterDispatchAuthorizationError(
        'AUTHORIZER_CLOSED',
        'Dispatch authorization client is closed.'
      ));
    }

    const jobId = typeof input.jobId === 'string' ? input.jobId : '';
    const printerDeviceId = typeof input.printerDeviceId === 'string' ? input.printerDeviceId : '';
    const windowsPrinterName = typeof input.windowsPrinterName === 'string' ? input.windowsPrinterName.trim() : '';
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(jobId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(printerDeviceId) ||
      !windowsPrinterName ||
      windowsPrinterName.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(windowsPrinterName)
    ) {
      return Promise.reject(new PrinterDispatchAuthorizationError(
        'INVALID_DISPATCH_REQUEST',
        'Dispatch authorization request contains an invalid job, device or Windows queue identity.'
      ));
    }

    const requestId = this.requestIdFactory();
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) || this.pending.has(requestId)) {
      return Promise.reject(new PrinterDispatchAuthorizationError(
        'INVALID_REQUEST_ID',
        'Dispatch authorization request ID is invalid or already in use.'
      ));
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new PrinterDispatchAuthorizationError(
          'AUTHORIZATION_TIMEOUT',
          'Backend dispatch authorization timed out. Physical submission was blocked.'
        ));
      }, this.timeoutMs);

      this.pending.set(requestId, {
        jobId,
        printerDeviceId,
        windowsPrinterName,
        resolve,
        reject,
        timeoutId
      });

      try {
        this.socket.emit('printer_device_dispatch_authorization_request', {
          requestId,
          jobId,
          printerDeviceId,
          windowsPrinterName
        });
      } catch (error) {
        clearTimeout(timeoutId);
        this.pending.delete(requestId);
        reject(new PrinterDispatchAuthorizationError(
          'AUTHORIZATION_SEND_FAILED',
          `Could not request backend dispatch authorization: ${error.message}`
        ));
      }
    });
  }

  startLeaseRenewal(authorization, input = {}, intervalMs = 25000) {
    const requestId = typeof authorization?.requestId === 'string' ? authorization.requestId : '';
    const jobId = typeof input.jobId === 'string' ? input.jobId : '';
    const printerDeviceId = typeof input.printerDeviceId === 'string' ? input.printerDeviceId : '';
    const windowsPrinterName = typeof input.windowsPrinterName === 'string' ? input.windowsPrinterName.trim() : '';
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(jobId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(printerDeviceId) ||
      !windowsPrinterName
    ) {
      throw new PrinterDispatchAuthorizationError(
        'INVALID_LEASE_IDENTITY',
        'A valid dispatch authorization and exact job/device/queue identity are required to renew a lease.'
      );
    }

    const payload = { requestId, jobId, printerDeviceId, windowsPrinterName };
    const timer = setInterval(() => {
      if (this.closed || this.socket.connected === false) return;
      this.socket.emit('printer_device_dispatch_lease_renewal', payload);
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return () => clearInterval(timer);
  }

  releaseLease(authorization, input = {}) {
    const requestId = typeof authorization?.requestId === 'string' ? authorization.requestId : '';
    const jobId = typeof input.jobId === 'string' ? input.jobId : '';
    const printerDeviceId = typeof input.printerDeviceId === 'string' ? input.printerDeviceId : '';
    const windowsPrinterName = typeof input.windowsPrinterName === 'string' ? input.windowsPrinterName.trim() : '';
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(jobId) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(printerDeviceId) ||
      !windowsPrinterName
    ) {
      throw new PrinterDispatchAuthorizationError(
        'INVALID_LEASE_IDENTITY',
        'A valid dispatch authorization and exact job/device/queue identity are required to release a lease.'
      );
    }

    if (!this.closed && this.socket.connected !== false) {
      this.socket.emit('printer_device_dispatch_lease_release', {
        requestId,
        jobId,
        printerDeviceId,
        windowsPrinterName
      });
      return true;
    }
    return false;
  }

  handleResult(payload) {
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
    const pending = this.pending.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    this.pending.delete(requestId);

    if (payload.allowed !== true) {
      pending.reject(new PrinterDispatchAuthorizationError(
        typeof payload.code === 'string' ? payload.code : 'DISPATCH_DENIED',
        `Backend denied physical dispatch: ${payload.code || 'DISPATCH_DENIED'}.`
      ));
      return;
    }

    if (
      payload.jobId !== pending.jobId ||
      payload.printerDeviceId !== pending.printerDeviceId ||
      payload.windowsPrinterName !== pending.windowsPrinterName
    ) {
      pending.reject(new PrinterDispatchAuthorizationError(
        'AUTHORIZATION_IDENTITY_MISMATCH',
        'Backend dispatch authorization identity does not match the pending job/device/queue request.'
      ));
      return;
    }

    pending.resolve(payload);
  }

  rejectAll(message) {
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId);
      this.pending.delete(requestId);
      pending.reject(new PrinterDispatchAuthorizationError('AGENT_DISCONNECTED', message));
    }
  }

  close() {
    this.closed = true;
    this.rejectAll('Dispatch authorization client closed.');
    if (typeof this.socket.off === 'function') {
      this.socket.off('printer_device_dispatch_authorization_result', this.onResult);
      this.socket.off('disconnect', this.onDisconnect);
    }
  }
}

module.exports = { PrinterDispatchAuthorizer, PrinterDispatchAuthorizationError };
