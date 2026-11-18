const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

    this.ensureDir();
    this.cleanupTempFiles();
    this.isCorrupted = false;
    this.corruptionReason = null;
    this.version = 1;
    this.installationInfo = null;
    this.data = this.load();
  }

  ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
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
    if (this.checkKeys && fs.existsSync(path.join(this.keysDir, 'private.pem'))) return true;
    return false;
  }

  writeMarker() {
    const markerData = {
      installationId: crypto.randomUUID(),
      provisionedAt: new Date().toISOString(),
      schemaVersion: 1
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
    this.version = 1;

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

      // If journal exists but marker is missing, backfill marker to ensure future safety
      if (!fs.existsSync(this.markerPath)) {
        this.writeMarker();
      }

      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw || raw.trim() === '') {
        // Empty file is corrupted / truncated
        this.isCorrupted = true;
        this.corruptionReason = 'Journal file is empty or truncated';
        return {};
      }

      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        this.isCorrupted = true;
        this.corruptionReason = 'Journal root is not an object';
        return {};
      }

      // Schema version check
      if (parsed.version !== undefined) {
        if (typeof parsed.version !== 'number' || parsed.version > 1) {
          this.isCorrupted = true;
          this.corruptionReason = `Unsupported journal schema version: ${parsed.version}`;
          return {};
        }
        this.version = parsed.version;
        return parsed.jobs && typeof parsed.jobs === 'object' ? parsed.jobs : {};
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
      version: this.version || 1,
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
      throw new Error(`Durable journal write failed: ${err.message}`);
    }
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
      this.data[jobId] = {
        jobId,
        state: 'RECEIVED',
        receivedAt: new Date().toISOString(),
        details,
        history: [{ state: 'RECEIVED', timestamp: new Date().toISOString() }]
      };
      this.save();
    }
  }

  recordDispatchIntent(jobId, details = {}) {
    if (!this.data[jobId]) {
      this.recordReceived(jobId, details);
    }
    const entry = this.data[jobId];
    entry.state = 'DISPATCH_INTENT';
    entry.dispatchIntentAt = new Date().toISOString();
    entry.printerName = details.printerName || entry.printerName;
    entry.history.push({ state: 'DISPATCH_INTENT', timestamp: new Date().toISOString(), details });
    this.save();
  }

  recordSpoolerAccepted(jobId, details = {}) {
    if (!this.data[jobId]) {
      this.recordReceived(jobId, details);
    }
    const entry = this.data[jobId];
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
