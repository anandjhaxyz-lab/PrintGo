const fs = require('fs');
const os = require('os');
const path = require('path');
const JobJournal = require('../src/journal');

describe('JobJournal multi-printer schema v2 compatibility', () => {
  let root;
  let journalPath;
  let markerPath;
  let keysDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'printgo-journal-v2-'));
    journalPath = path.join(root, 'jobs.journal.json');
    markerPath = path.join(root, '.installation_marker');
    keysDir = path.join(root, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({
      installationId: 'existing-installation',
      schemaVersion: 1
    }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('reads an existing v1 journal without rewriting it during startup', () => {
    const legacy = {
      version: 1,
      jobs: {
        old_job: {
          jobId: 'old_job',
          state: 'SPOOLER_ACCEPTED',
          printerName: 'Legacy Queue',
          history: [{ state: 'SPOOLER_ACCEPTED', timestamp: '2026-01-01T00:00:00.000Z' }]
        }
      }
    };
    const raw = JSON.stringify(legacy);
    fs.writeFileSync(journalPath, raw);

    const journal = new JobJournal(journalPath, { markerPath, keysDir, checkKeys: false });

    expect(journal.isCorrupted).toBe(false);
    expect(journal.getJob('old_job')).toEqual(legacy.jobs.old_job);
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(raw);
  });

  test('upgrades to v2 only on the next normal atomic save and preserves v1 history', () => {
    const legacy = {
      version: 1,
      jobs: {
        old_job: {
          jobId: 'old_job',
          state: 'RECEIVED',
          printerName: 'Legacy Queue',
          details: { originalName: 'old.pdf' },
          history: [{ state: 'RECEIVED', timestamp: '2026-01-01T00:00:00.000Z' }]
        }
      }
    };
    fs.writeFileSync(journalPath, JSON.stringify(legacy));

    const journal = new JobJournal(journalPath, { markerPath, keysDir, checkKeys: false });
    journal.recordDispatchIntent('new_job', {
      printerDeviceId: 'device-123',
      windowsPrinterName: 'Epson L6460'
    });

    const saved = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.jobs.old_job).toEqual(legacy.jobs.old_job);
    expect(saved.jobs.new_job).toEqual(expect.objectContaining({
      state: 'DISPATCH_INTENT',
      printerDeviceId: 'device-123',
      windowsPrinterName: 'Epson L6460',
      printerName: 'Epson L6460'
    }));
  });

  test('prevents a dispatched job from changing its physical printer binding', () => {
    const journal = new JobJournal(journalPath, {
      markerPath,
      keysDir,
      checkKeys: false,
      isProvisioning: true
    });

    journal.recordReceived('bound_job', {
      printerDeviceId: 'device-1',
      windowsPrinterName: 'Queue A'
    });
    journal.recordDispatchIntent('bound_job', {
      printerDeviceId: 'device-1',
      windowsPrinterName: 'Queue A'
    });

    expect(() => journal.recordDispatchIntent('bound_job', {
      printerDeviceId: 'device-2',
      windowsPrinterName: 'Queue B'
    })).toThrow(expect.objectContaining({ code: 'PRINTER_BINDING_MISMATCH' }));

    expect(journal.getJob('bound_job')).toEqual(expect.objectContaining({
      printerDeviceId: 'device-1',
      windowsPrinterName: 'Queue A'
    }));
  });

  test('rejects assigning a new device to a legacy job after dispatch has begun', () => {
    const journal = new JobJournal(journalPath, {
      markerPath,
      keysDir,
      checkKeys: false,
      isProvisioning: true
    });

    journal.recordReceived('legacy_job', { originalName: 'legacy.pdf' });
    journal.recordDispatchIntent('legacy_job', { printerName: 'Legacy Queue' });

    expect(() => journal.recordDispatchIntent('legacy_job', {
      printerDeviceId: 'device-1',
      windowsPrinterName: 'Queue A'
    })).toThrow(expect.objectContaining({ code: 'PRINTER_BINDING_MISMATCH' }));
  });

  test('fails closed on a future unsupported journal version', () => {
    fs.writeFileSync(journalPath, JSON.stringify({ version: 3, jobs: {} }));
    const journal = new JobJournal(journalPath, { markerPath, keysDir, checkKeys: false });

    expect(journal.isCorrupted).toBe(true);
    expect(journal.corruptionReason).toContain('Unsupported journal schema version: 3');
  });
});
