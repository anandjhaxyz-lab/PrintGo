const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

class JobJournal {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, '../data/jobs.journal.json');
    this.version = 1;
    this.jobs = {};
    this.ensureDir();
    this.load();
  }

  get data() {
    return this.jobs;
  }

  set data(val) {
    this.jobs = val || {};
  }

  ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
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

  _parseAndValidateRaw(raw, sourcePath) {
    if (!raw || raw.trim().length === 0) {
      throw new JournalCorruptionError(`Journal file at ${sourcePath} is empty or truncated`);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      throw new JournalCorruptionError(`Journal file contains invalid JSON at ${sourcePath}: ${parseErr.message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new JournalCorruptionError(`Invalid journal root schema at ${sourcePath}: expected object, got ${typeof parsed}`);
    }

    if ('version' in parsed) {
      if (parsed.version !== 1) {
        throw new JournalCorruptionError(`Unsupported journal version: ${parsed.version} at ${sourcePath}`);
      }
      if (!parsed.jobs || typeof parsed.jobs !== 'object' || Array.isArray(parsed.jobs)) {
        throw new JournalCorruptionError(`Corrupt journal: missing or invalid 'jobs' dictionary at ${sourcePath}`);
      }

      // Checksum validation
      const computedChecksum = JobJournal.computeChecksum(parsed.jobs);
      if (parsed.checksum && parsed.checksum !== computedChecksum) {
        throw new JournalCorruptionError(`Journal checksum mismatch at ${sourcePath}: expected ${parsed.checksum}, computed ${computedChecksum}`);
      }

      // Validate job entries
      for (const [id, entry] of Object.entries(parsed.jobs)) {
        if (!entry || typeof entry !== 'object' || entry.jobId !== id || !entry.state) {
          throw new JournalCorruptionError(`Corrupt job entry detected in journal: id=${id} at ${sourcePath}`);
        }
      }

      return { version: parsed.version, jobs: parsed.jobs, isLegacy: false };
    } else {
      // Legacy format: bare dictionary { [jobId]: entry }
      for (const [id, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== 'object' || !entry.state) {
          throw new JournalCorruptionError(`Corrupt legacy job entry: id=${id} at ${sourcePath}`);
        }
      }

      return { version: 1, jobs: parsed, isLegacy: true };
    }
  }

  load() {
    const dir = path.dirname(this.filePath);
    const baseName = path.basename(this.filePath);

    // 1. Primary journal file is missing: check for backups before initializing fresh
    if (!fs.existsSync(this.filePath)) {
      let dirEntries = [];
      try {
        dirEntries = fs.readdirSync(dir);
      } catch (dirErr) {
        throw new JournalCorruptionError(`Cannot inspect journal directory ${dir}: ${dirErr.message}`);
      }

      const bakPattern = new RegExp(`^\\.${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bak\\..+$`);
      const backupFiles = dirEntries.filter(f => bakPattern.test(f));

      if (backupFiles.length === 1) {
        // Exactly one backup exists: validate and safely recover
        const bakPath = path.join(dir, backupFiles[0]);
        console.warn(`⚠️ Primary journal missing at ${this.filePath}. Attempting crash recovery from backup: ${backupFiles[0]}`);

        let bakRaw;
        try {
          bakRaw = fs.readFileSync(bakPath, 'utf8');
        } catch (readErr) {
          throw new JournalCorruptionError(`Cannot read backup journal file at ${bakPath}: ${readErr.message}`);
        }

        // Validate strictly using standard validation logic (fails closed if corrupt)
        const validated = this._parseAndValidateRaw(bakRaw, bakPath);

        this.jobs = validated.jobs;
        this.version = validated.version;

        // Atomically persist recovered primary journal BEFORE unlinking backup
        this.save();

        // Safely unlink the backup only after the primary journal is durably installed
        try {
          fs.unlinkSync(bakPath);
        } catch (unlinkErr) {
          console.warn(`[JOURNAL_RECOVERY] Recovered primary journal, but failed to unlink consumed backup ${bakPath}: ${unlinkErr.message}`);
        }

        console.log(`[JOURNAL_RECOVERY] Successfully recovered primary journal from backup (${Object.keys(this.jobs).length} jobs).`);
        return this.jobs;
      } else if (backupFiles.length > 1) {
        // Multiple backups: ambiguous recovery, fail closed
        throw new JournalCorruptionError(
          `Ambiguous journal recovery: found ${backupFiles.length} backup files (${backupFiles.join(', ')}) ` +
          `while primary journal is missing. Manual operator investigation required.`
        );
      }

      // No backups exist and primary missing: Normal clean first-run startup
      this.jobs = {};
      this.save();
      return this.jobs;
    }

    // 2. Primary journal file exists: must be read and validated strictly (FAIL-CLOSED)
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (readErr) {
      throw new JournalCorruptionError(`Cannot read existing journal file at ${this.filePath}: ${readErr.message}`);
    }

    const validated = this._parseAndValidateRaw(raw, this.filePath);
    this.jobs = validated.jobs;
    this.version = validated.version;

    if (validated.isLegacy) {
      // Persist migrated versioned format with checksum immediately
      try {
        this.save();
        console.log(`[JOURNAL_MIGRATION] Successfully migrated legacy journal (${Object.keys(this.jobs).length} jobs) to versioned schema`);
      } catch (saveErr) {
        throw new JournalCorruptionError(`Failed to persist migrated journal: ${saveErr.message}`);
      }
    }

    return this.jobs;
  }

  save() {
    this.ensureDir();
    const dir = path.dirname(this.filePath);
    const baseName = path.basename(this.filePath);
    const tmpPath = path.join(dir, `.${baseName}.tmp.${Date.now()}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);

    const payload = {
      version: this.version || 1,
      updatedAt: new Date().toISOString(),
      checksum: JobJournal.computeChecksum(this.jobs),
      jobs: this.jobs
    };

    const serialized = JSON.stringify(payload, null, 2);

    let fd = null;
    try {
      fd = fs.openSync(tmpPath, 'w', 0o600);
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      // Windows-safe atomic replacement
      if (process.platform === 'win32') {
        try {
          fs.renameSync(tmpPath, this.filePath);
        } catch (renameErr) {
          if (renameErr.code === 'EPERM' || renameErr.code === 'EEXIST' || renameErr.code === 'EBUSY') {
            const bakPath = path.join(dir, `.${baseName}.bak.${Date.now()}`);
            let hasBak = false;
            if (fs.existsSync(this.filePath)) {
              fs.renameSync(this.filePath, bakPath);
              hasBak = true;
            }
            try {
              fs.renameSync(tmpPath, this.filePath);
              if (hasBak && fs.existsSync(bakPath)) {
                try { fs.unlinkSync(bakPath); } catch (_) {}
              }
            } catch (innerErr) {
              if (hasBak && fs.existsSync(bakPath) && !fs.existsSync(this.filePath)) {
                try { fs.renameSync(bakPath, this.filePath); } catch (_) {}
              }
              throw innerErr;
            }
          } else {
            throw renameErr;
          }
        }
      } else {
        fs.renameSync(tmpPath, this.filePath);
      }
    } catch (err) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_) {}
      }
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
      throw new JournalPersistenceError(`Journal atomic persistence failed: ${err.message}`);
    }
  }

  hasJob(jobId) {
    return !!this.jobs[jobId];
  }

  isDispatched(jobId) {
    const entry = this.jobs[jobId];
    if (!entry) return false;
    return [
      'DISPATCHED_TO_SPOOLER',
      'SPOOLING',
      'COMPLETED_LOCALLY',
      'ACKNOWLEDGED',
      'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW'
    ].includes(entry.state);
  }

  recordReceived(jobId, details = {}) {
    if (!this.jobs[jobId]) {
      this.jobs[jobId] = {
        jobId,
        state: 'RECEIVED',
        receivedAt: new Date().toISOString(),
        details,
        history: [{ state: 'RECEIVED', timestamp: new Date().toISOString() }]
      };
      this.save();
    }
  }

  recordDispatched(jobId, details = {}) {
    if (!this.jobs[jobId]) {
      this.recordReceived(jobId, details);
    }
    const entry = this.jobs[jobId];
    entry.state = 'DISPATCHED_TO_SPOOLER';
    entry.dispatchedAt = new Date().toISOString();
    entry.printerName = details.printerName || entry.printerName;
    entry.history.push({ state: 'DISPATCHED_TO_SPOOLER', timestamp: new Date().toISOString(), details });
    this.save();
  }

  recordCompleted(jobId, details = {}) {
    if (!this.jobs[jobId]) {
      this.recordReceived(jobId, details);
    }
    const entry = this.jobs[jobId];
    entry.state = 'COMPLETED_LOCALLY';
    entry.completedAt = new Date().toISOString();
    entry.history.push({ state: 'COMPLETED_LOCALLY', timestamp: new Date().toISOString(), details });
    this.save();
  }

  recordAcknowledged(jobId) {
    if (this.jobs[jobId]) {
      this.jobs[jobId].state = 'ACKNOWLEDGED';
      this.jobs[jobId].acknowledgedAt = new Date().toISOString();
      this.jobs[jobId].history.push({ state: 'ACKNOWLEDGED', timestamp: new Date().toISOString() });
      this.save();
    }
  }

  getJob(jobId) {
    return this.jobs[jobId] || null;
  }

  getUnacknowledgedJobs() {
    return Object.values(this.jobs).filter(j =>
      j.state === 'COMPLETED_LOCALLY' ||
      j.state === 'DISPATCHED_TO_SPOOLER' ||
      j.state === 'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW'
    );
  }

  recoverOnStartup() {
    let modified = false;
    for (const job of Object.values(this.jobs)) {
      if (job.state === 'DISPATCHED_TO_SPOOLER' || job.state === 'SPOOLING') {
        console.warn(`⚠️ Startup recovery: In-flight job ${job.jobId} marked as AMBIGUOUS_REQUIRES_OPERATOR_REVIEW`);
        job.state = 'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW';
        job.history.push({
          state: 'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW',
          timestamp: new Date().toISOString(),
          reason: 'Agent restarted with job unconfirmed'
        });
        modified = true;
      }
    }
    if (modified) {
      this.save();
    }
  }
}

JobJournal.JournalCorruptionError = JournalCorruptionError;
JobJournal.JournalPersistenceError = JournalPersistenceError;

module.exports = JobJournal;
