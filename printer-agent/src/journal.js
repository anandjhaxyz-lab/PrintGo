const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const journalSecret = require('./journalSecret');

const CURRENT_JOURNAL_VERSION = 2;

class JournalCorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JournalCorruptionError';
  }
}

class JournalPersistenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JournalPersistenceError';
  }
}

function atomicRenameWithRetry(srcPath, destPath, maxRetries = 5, initialDelayMs = 25) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.renameSync(srcPath, destPath);
      return; // Atomic rename succeeded
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) {
        break;
      }
      // Windows transient locking backoff: 25ms, 50ms, 100ms, 200ms...
      const delay = initialDelayMs * Math.pow(2, attempt - 1);
      const start = Date.now();
      while (Date.now() - start < delay) {
        // synchronous spin-wait
      }
    }
  }
  throw lastError;
}

class JobJournal {
  constructor(filePath, options = {}) {
    this.filePath = filePath || path.join(__dirname, '../data/jobs.journal.json');
    this.markerPath = options.markerPath || path.join(path.dirname(this.filePath), '.installation_marker');
    this.keysDir = options.keysDir || path.join(path.dirname(this.filePath), '../keys');

    // Explicit provisioning must be an intentional action.
    // CLI argument --provision is the preferred one-time transient flag.
    const hasProvisionArg = process.argv.includes('--provision');
    const hasProvisionEnv = process.env.AGENT_PROVISIONING === 'true';

    // Scrub environment variable immediately to prevent accidental persistent enablement
    if (process.env.AGENT_PROVISIONING !== undefined) {
      delete process.env.AGENT_PROVISIONING;
    }

    this.isProvisioning = options.isProvisioning !== undefined
      ? !!options.isProvisioning
      : (hasProvisionArg || hasProvisionEnv);
    this.forceReprovision = !!options.forceReprovision || process.argv.includes('--force-reprovision');
    this.checkKeys = options.checkKeys !== undefined ? options.checkKeys : true;
    this.secretPath = options.secretPath || path.join(path.dirname(this.filePath), '.journal_secret');
    this.secret = null;
    this.checkSecret = options.checkSecret !== undefined ? options.checkSecret : this.checkKeys;
    const rawMachineKey = options.machineKey !== undefined ? options.machineKey : process.env.MACHINE_KEY;
    this.machineKey = typeof rawMachineKey === 'string' ? rawMachineKey.trim() : rawMachineKey;
    this.currentSid = options.currentSid || null;
    this.expectedSid = options.expectedSid || null;
    this.dpapiProvider = options.dpapiProvider || null;
    this.provisioningInstallationId = options.installationId || null;

    this.ensureDir();
    this.cleanupTempFiles();
    this.isCorrupted = false;
    this.corruptionReason = null;
    this.version = CURRENT_JOURNAL_VERSION;
    this.installationInfo = null;
    this.data = this.load();
  }

  ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  get jobs() {
    return this.data;
  }

  set jobs(val) {
    this.data = val || {};
  }

  static computeChecksum(jobs) {
    if (!jobs || typeof jobs !== 'object') return '';
    const sortedKeys = Object.keys(jobs).sort();
    const canonical = {};
    for (const k of sortedKeys) {
      canonical[k] = jobs[k];
    }
    return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
  }

  recoverOnStartup() {
    if (!this.data || typeof this.data !== 'object') return;
    for (const [id, entry] of Object.entries(this.data)) {
      if (entry && ['DISPATCH_INTENT', 'DISPATCHED_TO_SPOOLER', 'SPOOLING'].includes(entry.state)) {
        entry.state = 'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW';
        entry.history = entry.history || [];
        entry.history.push({
          state: 'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW',
          timestamp: new Date().toISOString(),
          reason: 'Startup crash recovery'
        });
      }
    }
    this.save();
  }

  cleanupTempFiles() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) return;
      const baseName = path.basename(this.filePath);
      const prefix = `${baseName}.tmp.`;
      const files = fs.readdirSync(dir);
      const now = Date.now();
      for (const f of files) {
        if (f.startsWith(prefix) || f.startsWith('.installation_marker.tmp.')) {
          const fullPath = path.join(dir, f);
          try {
            const stats = fs.statSync(fullPath);
            // Remove orphan temp files older than 10 seconds
            if (now - stats.mtimeMs > 10000) {
              fs.unlinkSync(fullPath);
            }
          } catch {}
        }
      }
    } catch (e) {
      // Best-effort cleanup; ignore errors
    }
  }

  isExistingInstallation() {
    if (fs.existsSync(this.markerPath)) return true;
    if (this.checkSecret && fs.existsSync(this.secretPath)) return true;
    if (this.checkKeys && fs.existsSync(path.join(this.keysDir, 'private.pem'))) return true;
    return false;
  }

  writeMarker(options = {}) {
    const instId = options.installationId || this.provisioningInstallationId || crypto.randomUUID();
    let userSid = options.userSid || this.currentSid;
    let userName = options.userName || process.env.USERNAME || null;
    if (!userSid) {
      try {
        userSid = journalSecret.getCurrentWindowsSid();
      } catch (e) {
        userSid = null;
      }
    }
    const markerData = {
      installationId: instId,
      provisionedAt: new Date().toISOString(),
      schemaVersion: 1,
      securityContext: {
        userSid: userSid || null,
        userName: userName
      }
    };
    const markerPayload = JSON.stringify(markerData, null, 2);
    const tempMarker = `${this.markerPath}.tmp.${Date.now()}_${crypto.randomUUID()}`;
    let fd = null;
    try {
      fd = fs.openSync(tempMarker, 'w');
      fs.writeSync(fd, markerPayload, 0, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      atomicRenameWithRetry(tempMarker, this.markerPath, 5, 25);
    } catch (err) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (fs.existsSync(tempMarker)) {
        try { fs.unlinkSync(tempMarker); } catch {}
      }
      throw new Error(`Durable installation marker write failed: ${err.message}`);
    }
    this.installationInfo = markerData;
    return markerData;
  }

  load() {
    this.isCorrupted = false;
    this.corruptionReason = null;
    // Current writer is v2, but reading v0/v1 never rewrites the source file.
    this.version = CURRENT_JOURNAL_VERSION;

    try {
      const journalExists = fs.existsSync(this.filePath);
      const isExisting = this.isExistingInstallation();

      if (this.forceReprovision) {
        // Authorized force-reprovision: resets marker and initializes clean state
        this.writeMarker();
        return {};
      }

      if (!journalExists) {
        if (isExisting && !this.forceReprovision) {
          // FAIL CLOSED: Existing installation detected whose journal was lost or deleted!
          // Standard provisioning (even if accidentally enabled in env) cannot overwrite
          // an existing installation with missing journal. Requires explicit forceReprovision.
          this.isCorrupted = true;
          this.corruptionReason = 'Existing installation detected, but journal file is missing. Fails closed to prevent duplicate physical prints.';
          return {};
        }

        if (!isExisting && !this.isProvisioning) {
          // FAIL CLOSED: Unprovisioned installation: identity anchors missing.
          // Must not silently initialize without explicit authorized provisioning.
          this.isCorrupted = true;
          this.corruptionReason = 'Unprovisioned installation: identity anchors missing and explicit provisioning not authorized. Fails closed.';
          return {};
        }

        // Legitimate fresh install with explicit authorized provisioning
        this.writeMarker();
        return {};
      }

      // If journal exists but marker is missing: FAIL CLOSED!
      // Must not silently backfill marker for unanchored/legacy journal without authorized migration.
      if (!fs.existsSync(this.markerPath)) {
        this.isCorrupted = true;
        this.corruptionReason = 'Existing journal detected but installation marker is missing. Fails closed to prevent duplicate physical prints.';
        return {};
      }

      try {
        this.installationInfo = JSON.parse(fs.readFileSync(this.markerPath, 'utf8'));
      } catch (err) {
        this.isCorrupted = true;
        this.corruptionReason = `Installation marker exists but is corrupted: ${err.message}`;
        return {};
      }

      // WP-1 Secret Verification: in runtime, verify journal secret under current Windows SID
      if (!this.isProvisioning && this.checkSecret) {
        try {
          const expectedSid = this.expectedSid || (this.installationInfo && this.installationInfo.securityContext && this.installationInfo.securityContext.userSid);
          this.secret = journalSecret.loadSecret({
            secretPath: this.secretPath,
            expectedSid: expectedSid,
            currentSid: this.currentSid,
            dpapiProvider: this.dpapiProvider,
            markerPath: this.markerPath,
            machineKey: this.machineKey
          });
        } catch (secErr) {
          this.isCorrupted = true;
          const codePrefix = secErr.code ? `[${secErr.code}] ` : '';
          this.corruptionReason = `Journal secret verification failed: ${codePrefix}${secErr.message}`;
          this.secret = null;
          return {};
        }
      }

      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw || raw.trim() === '') {
        // Empty file is corrupted / truncated
        this.isCorrupted = true;
        this.corruptionReason = 'Journal file is empty or truncated';
        return {};
      }

      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        this.isCorrupted = true;
        this.corruptionReason = 'Journal root is not an object';
        return {};
      }

      // V1 journals are read in place. The file is upgraded to v2 only on a later
      // ordinary atomic save, so startup does not mutate historic recovery evidence.
      if (parsed.version !== undefined) {
        if (
          typeof parsed.version !== 'number' ||
          !Number.isInteger(parsed.version) ||
          parsed.version < 0 ||
          parsed.version > CURRENT_JOURNAL_VERSION
        ) {
          this.isCorrupted = true;
          this.corruptionReason = `Unsupported journal schema version: ${parsed.version}`;
          return {};
        }

        if (parsed.jobs === undefined || typeof parsed.jobs !== 'object' || parsed.jobs === null || Array.isArray(parsed.jobs)) {
          this.isCorrupted = true;
          this.corruptionReason = 'Journal jobs collection is malformed';
          return {};
        }

        return parsed.jobs;
      }

      // Backwards compatibility with v0 format (direct key-value map of jobs)
      const legacyJobs = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v === 'object' && v.jobId) {
          legacyJobs[k] = v;
        }
      }
      return legacyJobs;
    } catch (e) {
      this.isCorrupted = true;
      this.corruptionReason = `Journal read/parse failed: ${e.message}`;
      console.warn('⚠️ Could not load journal (flagged corrupted):', e.message);
      return {};
    }
  }

  save() {
    const tempPath = `${this.filePath}.tmp.${Date.now()}_${crypto.randomUUID()}`;
    const payload = JSON.stringify({
      version: CURRENT_JOURNAL_VERSION,
      jobs: this.data
    }, null, 2);

    let fd = null;
    try {
      fd = fs.openSync(tempPath, 'w');
      fs.writeSync(fd, payload, 0, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      // Atomic rename with bounded retry. Never overwrite using unsafe copyFileSync!
      atomicRenameWithRetry(tempPath, this.filePath, 5, 25);
    } catch (err) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      // Clean up ONLY the temporary file belonging to this failed operation
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
      console.error('🔥 Failed to persist job journal atomically:', err.message);
      throw new JournalPersistenceError(`Durable journal write failed: ${err.message}`);
    }
  }

  validatePrinterBinding(details = {}) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
      throw new Error('Invalid journal event details.');
    }

    const hasDeviceId = details.printerDeviceId !== undefined && details.printerDeviceId !== null;
    const hasQueueName = details.windowsPrinterName !== undefined && details.windowsPrinterName !== null;
    if (!hasDeviceId && !hasQueueName) return null;

    const printerDeviceId = typeof details.printerDeviceId === 'string' ? details.printerDeviceId.trim() : '';
    const windowsPrinterName = typeof details.windowsPrinterName === 'string' ? details.windowsPrinterName.trim() : '';

    if (
      !printerDeviceId ||
      printerDeviceId.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(printerDeviceId) ||
      !windowsPrinterName ||
      windowsPrinterName.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(windowsPrinterName)
    ) {
      throw new Error('PrinterDeviceId and exact Windows queue name must be provided together.');
    }

    if (details.printerName && details.printerName !== windowsPrinterName) {
      const error = new Error('Legacy printerName does not match windowsPrinterName.');
      error.code = 'PRINTER_BINDING_MISMATCH';
      throw error;
    }

    return { printerDeviceId, windowsPrinterName };
  }

  applyPrinterBinding(entry, details = {}) {
    const binding = this.validatePrinterBinding(details);
    if (!binding) return;

    const existingId = entry.printerDeviceId || null;
    const existingQueue = entry.windowsPrinterName || null;
    const legacyQueue = entry.printerName || null;

    if (
      (existingId && existingId !== binding.printerDeviceId) ||
      (existingQueue && existingQueue !== binding.windowsPrinterName) ||
      (legacyQueue && legacyQueue !== binding.windowsPrinterName)
    ) {
      const error = new Error('A journalled job cannot be rebound to a different physical printer.');
      error.code = 'PRINTER_BINDING_MISMATCH';
      throw error;
    }

    if ((!existingId || !existingQueue) && entry.state !== 'RECEIVED') {
      const error = new Error('A legacy job cannot receive a new physical printer binding after dispatch has begun.');
      error.code = 'PRINTER_BINDING_MISMATCH';
      throw error;
    }

    entry.printerDeviceId = binding.printerDeviceId;
    entry.windowsPrinterName = binding.windowsPrinterName;
  }

  isCorruptedEntry(entry) {
    if (!entry || typeof entry !== 'object') return true;
    if (!entry.jobId || typeof entry.jobId !== 'string') return true;
    if (!entry.state || typeof entry.state !== 'string') return true;
    return false;
  }

  hasJob(jobId) {
    return !!this.data[jobId];
  }

  /**
   * Classifies a duplicate delivery without treating spooler handoff as proof
   * of physical completion. Unknown or malformed states fail closed.
   *
   * PROCESS: no prior entry, or RECEIVED before dispatch intent.
   * COMPLETED: durable local completion evidence exists.
   * AMBIGUOUS: dispatch may have reached the driver, or evidence is unreliable.
   */
  getReplayDisposition(jobId) {
    if (this.isCorrupted) return 'AMBIGUOUS';

    const entry = this.data[jobId];
    if (!entry) return 'PROCESS';
    if (this.isCorruptedEntry(entry)) return 'AMBIGUOUS';

    if (entry.state === 'RECEIVED') return 'PROCESS';
    if (['COMPLETED_LOCALLY', 'ACKNOWLEDGED'].includes(entry.state)) {
      return 'COMPLETED';
    }
    if (['DISPATCH_INTENT', 'DISPATCHED_TO_SPOOLER', 'SPOOLER_ACCEPTED', 'SPOOLING'].includes(entry.state)) {
      return 'AMBIGUOUS';
    }

    // Unrecognized states must never authorize another physical submission.
    return 'AMBIGUOUS';
  }

  isDispatched(jobId) {
    const entry = this.data[jobId];
    if (!entry) return false;
    return [
      'DISPATCH_INTENT',
      'DISPATCHED_TO_SPOOLER',
      'SPOOLER_ACCEPTED',
      'SPOOLING',
      'COMPLETED_LOCALLY',
      'ACKNOWLEDGED'
    ].includes(entry.state);
  }

  recordReceived(jobId, details = {}) {
    if (!this.data[jobId]) {
      const entry = {
        jobId,
        state: 'RECEIVED',
        receivedAt: new Date().toISOString(),
        details,
        history: [{ state: 'RECEIVED', timestamp: new Date().toISOString() }]
      };
      this.applyPrinterBinding(entry, details);
      if (details.printerName) entry.printerName = details.printerName;
      this.data[jobId] = entry;
      this.save();
    }
  }

  recordDispatchIntent(jobId, details = {}) {
    if (!this.data[jobId]) {
      this.recordReceived(jobId, details);
    }
    const entry = this.data[jobId];
    this.applyPrinterBinding(entry, details);
    entry.state = 'DISPATCH_INTENT';
    entry.dispatchIntentAt = new Date().toISOString();
    entry.printerName = details.printerName || details.windowsPrinterName || entry.printerName;
    entry.history.push({ state: 'DISPATCH_INTENT', timestamp: new Date().toISOString(), details });
    this.save();
  }

  recordSpoolerAccepted(jobId, details = {}) {
    if (!this.data[jobId]) {
      this.recordReceived(jobId, details);
    }
    const entry = this.data[jobId];
    this.applyPrinterBinding(entry, details);
    entry.state = 'SPOOLER_ACCEPTED';
    entry.spoolerAcceptedAt = new Date().toISOString();
    entry.history.push({ state: 'SPOOLER_ACCEPTED', timestamp: new Date().toISOString(), details });
    this.save();
  }

  recordDispatched(jobId, details = {}) {
    // Backwards compatibility alias
    this.recordDispatchIntent(jobId, details);
  }

  recordCompleted(jobId, details = {}) {
    if (!this.data[jobId]) {
      this.recordReceived(jobId, details);
    }
    const entry = this.data[jobId];
    this.applyPrinterBinding(entry, details);
    entry.state = 'COMPLETED_LOCALLY';
    entry.completedAt = new Date().toISOString();
    entry.history.push({ state: 'COMPLETED_LOCALLY', timestamp: new Date().toISOString(), details });
    this.save();
  }

  recordAcknowledged(jobId) {
    if (this.data[jobId]) {
      this.data[jobId].state = 'ACKNOWLEDGED';
      this.data[jobId].acknowledgedAt = new Date().toISOString();
      this.data[jobId].history.push({ state: 'ACKNOWLEDGED', timestamp: new Date().toISOString() });
      this.save();
    }
  }

  getJob(jobId) {
    return this.data[jobId] || null;
  }

  getUnacknowledgedJobs() {
    return Object.values(this.data).filter(j => j.state === 'COMPLETED_LOCALLY' || j.state === 'DISPATCHED_TO_SPOOLER');
  }
}

module.exports = JobJournal;
module.exports.JobJournal = JobJournal;
module.exports.JournalCorruptionError = JournalCorruptionError;
module.exports.JournalPersistenceError = JournalPersistenceError;
