const fs = require('fs');
const path = require('path');

class JobJournal {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, '../data/jobs.journal.json');
    this.ensureDir();
    this.data = this.load();
  }

  ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn('⚠️ Could not load journal, initializing fresh:', e.message);
    }
    return {};
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('🔥 Failed to persist job journal:', e.message);
    }
  }

  hasJob(jobId) {
    return !!this.data[jobId];
  }

  isDispatched(jobId) {
    const entry = this.data[jobId];
    if (!entry) return false;
    return ['DISPATCHED_TO_SPOOLER', 'SPOOLING', 'COMPLETED_LOCALLY', 'ACKNOWLEDGED'].includes(entry.state);
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

  recordDispatched(jobId, details = {}) {
    if (!this.data[jobId]) {
      this.recordReceived(jobId, details);
    }
    const entry = this.data[jobId];
    entry.state = 'DISPATCHED_TO_SPOOLER';
    entry.dispatchedAt = new Date().toISOString();
    entry.printerName = details.printerName || entry.printerName;
    entry.history.push({ state: 'DISPATCHED_TO_SPOOLER', timestamp: new Date().toISOString(), details });
    this.save();
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
