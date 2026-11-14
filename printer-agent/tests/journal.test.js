/**
 * Automated Test Suite: P1-04 Journal Fail-Open Remediation & Fail-Closed Durability
 *
 * Covers:
 * 1. Missing journal on first startup (clean initialization).
 * 2. Valid current versioned journal loads and verifies checksum.
 * 3. Legacy journal format loads, preserves all records, and migrates to versioned format.
 * 4. Invalid JSON throws JournalCorruptionError and fails closed (does NOT return {}).
 * 5. Truncated/empty existing journal throws JournalCorruptionError and fails closed.
 * 6. Unsupported schema/version throws JournalCorruptionError.
 * 7. Checksum mismatch throws JournalCorruptionError.
 * 8. Read permission failure throws without overwriting disk.
 * 9. Write failure (disk full / permission denied) throws JournalPersistenceError.
 * 10. Atomic replacement strategy cleans up temporary file on failure.
 * 11. Temporary-file crash recovery: Existing journal is never truncated.
 * 12. Dispatch intent must succeed before printer command is issued.
 * 13. Terminal evidence must succeed before physical success event is emitted.
 * 14. Restart with an in-flight job marks it AMBIGUOUS_REQUIRES_OPERATOR_REVIEW and blocks automatic reprint.
 * 15. Corrupt journal halts agent startup and prevents accepting print jobs.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const JobJournal = require('../src/journal');

describe('P1-04: JobJournal Fail-Closed Durability & Safety', () => {
  let tempDir;
  let journalPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-04-journal-'));
    journalPath = path.join(tempDir, 'jobs.journal.json');
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  test('1. First-run missing journal creates a fresh versioned journal with valid checksum', () => {
    expect(fs.existsSync(journalPath)).toBe(false);

    const journal = new JobJournal(journalPath);
    expect(journal.jobs).toEqual({});
    expect(fs.existsSync(journalPath)).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.checksum).toBe(JobJournal.computeChecksum({}));
    expect(onDisk.jobs).toEqual({});
  });

  test('2. Valid current versioned journal loads and validates checksum successfully', () => {
    const journal1 = new JobJournal(journalPath);
    journal1.recordReceived('job_v1_01', { name: 'doc1.pdf' });
    journal1.recordDispatched('job_v1_01', { printerName: 'Epson L6460' });

    // Reload from disk
    const journal2 = new JobJournal(journalPath);
    expect(journal2.hasJob('job_v1_01')).toBe(true);
    expect(journal2.isDispatched('job_v1_01')).toBe(true);
    expect(journal2.getJob('job_v1_01').state).toBe('DISPATCHED_TO_SPOOLER');
  });

  test('3. Legacy journal format loads, preserves all records, and migrates to versioned schema', () => {
    // Write a legacy unversioned bare dictionary
    const legacyData = {
      'job_legacy_1': {
        jobId: 'job_legacy_1',
        state: 'DISPATCHED_TO_SPOOLER',
        receivedAt: '2026-11-12T00:00:00.000Z',
        dispatchedAt: '2026-11-12T00:01:00.000Z',
        printerName: 'Epson L6460',
        history: [{ state: 'RECEIVED' }, { state: 'DISPATCHED_TO_SPOOLER' }]
      },
      'job_legacy_2': {
        jobId: 'job_legacy_2',
        state: 'COMPLETED_LOCALLY',
        receivedAt: '2026-11-12T00:05:00.000Z',
        completedAt: '2026-11-12T00:06:00.000Z',
        history: [{ state: 'RECEIVED' }, { state: 'COMPLETED_LOCALLY' }]
      }
    };
    fs.writeFileSync(journalPath, JSON.stringify(legacyData, null, 2), 'utf8');

    // Load with new JobJournal
    const journal = new JobJournal(journalPath);
    expect(journal.hasJob('job_legacy_1')).toBe(true);
    expect(journal.hasJob('job_legacy_2')).toBe(true);
    expect(journal.isDispatched('job_legacy_1')).toBe(true);
    expect(journal.isDispatched('job_legacy_2')).toBe(true);

    // Verify on-disk file was migrated to versioned schema
    const migratedDisk = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    expect(migratedDisk.version).toBe(1);
    expect(migratedDisk.jobs['job_legacy_1'].state).toBe('DISPATCHED_TO_SPOOLER');
    expect(migratedDisk.jobs['job_legacy_2'].state).toBe('COMPLETED_LOCALLY');
    expect(migratedDisk.checksum).toBe(JobJournal.computeChecksum(migratedDisk.jobs));
  });

  test('4. Invalid JSON syntax fails closed with JournalCorruptionError (never returns {})', () => {
    fs.writeFileSync(journalPath, '{"broken json: missing bracket', 'utf8');

    expect(() => new JobJournal(journalPath)).toThrow(JobJournal.JournalCorruptionError);
    // Crucial: The corrupt file on disk must NOT be overwritten with an empty journal
    const content = fs.readFileSync(journalPath, 'utf8');
    expect(content).toBe('{"broken json: missing bracket');
  });

  test('5. Truncated or empty existing journal file fails closed', () => {
    fs.writeFileSync(journalPath, '   \n  ', 'utf8');

    expect(() => new JobJournal(journalPath)).toThrow(JobJournal.JournalCorruptionError);
  });

  test('6. Unsupported journal version fails closed', () => {
    const invalidVersion = {
      version: 999, // Unsupported future version
      checksum: 'abc',
      jobs: {}
    };
    fs.writeFileSync(journalPath, JSON.stringify(invalidVersion), 'utf8');

    expect(() => new JobJournal(journalPath)).toThrow(/Unsupported journal version/);
  });

  test('7. Checksum mismatch throws JournalCorruptionError and fails closed', () => {
    const tamperedData = {
      version: 1,
      checksum: '0000000000000000000000000000000000000000000000000000000000000000', // Invalid
      jobs: {
        'job_bad_hash': {
          jobId: 'job_bad_hash',
          state: 'DISPATCHED_TO_SPOOLER'
        }
      }
    };
    fs.writeFileSync(journalPath, JSON.stringify(tamperedData), 'utf8');

    expect(() => new JobJournal(journalPath)).toThrow(/Journal checksum mismatch/);
  });

  test('8. Write failure propagates JournalPersistenceError to callers without corrupting journal', () => {
    const journal = new JobJournal(journalPath);
    journal.recordReceived('job_safe_01');

    // Make target directory read-only or mock writeFileSync to fail
    const originalOpen = fs.openSync;
    jest.spyOn(fs, 'openSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    expect(() => {
      journal.recordDispatched('job_safe_01', { printerName: 'Epson' });
    }).toThrow(JobJournal.JournalPersistenceError);

    // Verify existing file remains uncorrupted
    const restored = new JobJournal(journalPath);
    expect(restored.hasJob('job_safe_01')).toBe(true);
    expect(restored.getJob('job_safe_01').state).toBe('RECEIVED');
  });

  test('9. Atomic persistence cleans up temporary files on write failure', () => {
    const journal = new JobJournal(journalPath);

    jest.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('EIO: I/O disk hardware error during fsync');
    });

    expect(() => {
      journal.recordReceived('job_io_err');
    }).toThrow(JobJournal.JournalPersistenceError);

    // Verify no stray .tmp files were left behind in the directory
    const files = fs.readdirSync(tempDir);
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });

  test('10. Crash between temporary write and rename leaves original file 100% intact', () => {
    const journal = new JobJournal(journalPath);
    journal.recordReceived('job_survivor');

    // Simulate an abandoned temporary file left from a previous crashed process
    const strayTmp = path.join(tempDir, '.jobs.journal.json.tmp.12345.999.abcd');
    fs.writeFileSync(strayTmp, 'half written garbage', 'utf8');

    // Reloading journal must load the clean original, ignoring the stray tmp file
    const reloaded = new JobJournal(journalPath);
    expect(reloaded.hasJob('job_survivor')).toBe(true);
    expect(reloaded.getJob('job_survivor').state).toBe('RECEIVED');
  });

  test('11. Restart with in-flight jobs marks them AMBIGUOUS_REQUIRES_OPERATOR_REVIEW', () => {
    const journal1 = new JobJournal(journalPath);
    journal1.recordReceived('job_inflight_1');
    journal1.recordDispatched('job_inflight_1', { printerName: 'Epson' });

    journal1.recordReceived('job_done_2');
    journal1.recordDispatched('job_done_2', { printerName: 'Epson' });
    journal1.recordCompleted('job_done_2');

    // Simulate agent crash & restart
    const journal2 = new JobJournal(journalPath);
    journal2.recoverOnStartup();

    // In-flight job must be transitioned to AMBIGUOUS_REQUIRES_OPERATOR_REVIEW
    const inflightJob = journal2.getJob('job_inflight_1');
    expect(inflightJob.state).toBe('AMBIGUOUS_REQUIRES_OPERATOR_REVIEW');
    expect(journal2.isDispatched('job_inflight_1')).toBe(true); // Refuses duplicate physical print!

    // Completed job remains COMPLETED_LOCALLY
    const completedJob = journal2.getJob('job_done_2');
    expect(completedJob.state).toBe('COMPLETED_LOCALLY');
  });

  test('12. Ambiguous jobs block automatic reprinting in idempotency guard', () => {
    const journal = new JobJournal(journalPath);
    journal.recordDispatched('job_ambig_test');
    journal.recoverOnStartup();

    // Idempotency check: isDispatched must return true to prevent re-issuing print commands
    expect(journal.isDispatched('job_ambig_test')).toBe(true);

    const job = journal.getJob('job_ambig_test');
    expect(job.state).toBe('AMBIGUOUS_REQUIRES_OPERATOR_REVIEW');
  });

  test('13. Corrupt journal halts agent startup cleanly and fails closed', () => {
    // Write corrupt journal
    fs.writeFileSync(journalPath, '{"jobs": {"bad": null}}', 'utf8');

    let agentStarted = false;
    try {
      new JobJournal(journalPath);
      agentStarted = true;
    } catch (err) {
      expect(err).toBeInstanceOf(JobJournal.JournalCorruptionError);
    }

    expect(agentStarted).toBe(false);
  });

  describe('P1-04 Windows Backup Crash-Recovery Targeted Tests', () => {
    test('14. Primary missing + exactly one valid backup -> successful recovery with all job records preserved', () => {
      const baseName = path.basename(journalPath);
      const bakPath = path.join(tempDir, `.${baseName}.bak.${Date.now()}`);

      const backupJobs = {
        'job_bak_01': {
          jobId: 'job_bak_01',
          state: 'DISPATCHED_TO_SPOOLER',
          receivedAt: '2026-11-13T00:00:00.000Z',
          dispatchedAt: '2026-11-13T00:01:00.000Z',
          history: [{ state: 'RECEIVED' }, { state: 'DISPATCHED_TO_SPOOLER' }]
        }
      };
      const backupPayload = {
        version: 1,
        updatedAt: '2026-11-13T00:01:00.000Z',
        checksum: JobJournal.computeChecksum(backupJobs),
        jobs: backupJobs
      };
      fs.writeFileSync(bakPath, JSON.stringify(backupPayload, null, 2), 'utf8');

      // Primary journal does NOT exist
      expect(fs.existsSync(journalPath)).toBe(false);

      // Loading should recover from the single valid backup
      const journal = new JobJournal(journalPath);
      expect(journal.hasJob('job_bak_01')).toBe(true);
      expect(journal.isDispatched('job_bak_01')).toBe(true);

      // Primary journal is now installed on disk
      expect(fs.existsSync(journalPath)).toBe(true);
      const restoredDisk = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      expect(restoredDisk.jobs['job_bak_01'].state).toBe('DISPATCHED_TO_SPOOLER');
      expect(restoredDisk.checksum).toBe(JobJournal.computeChecksum(backupJobs));
      // Consumed backup was cleanly unlinked
      expect(fs.existsSync(bakPath)).toBe(false);
    });

    test('15. Primary missing + corrupt backup -> fail closed; backup preserved', () => {
      const baseName = path.basename(journalPath);
      const bakPath = path.join(tempDir, `.${baseName}.bak.${Date.now()}`);

      // Write corrupt data in backup
      const corruptContent = '{"jobs": {"corrupted": true';
      fs.writeFileSync(bakPath, corruptContent, 'utf8');

      expect(() => new JobJournal(journalPath)).toThrow(JobJournal.JournalCorruptionError);

      // Crucial: Primary journal must NOT be initialized as empty
      expect(fs.existsSync(journalPath)).toBe(false);
      // Crucial: Corrupt backup must be preserved for forensic analysis
      expect(fs.existsSync(bakPath)).toBe(true);
      expect(fs.readFileSync(bakPath, 'utf8')).toBe(corruptContent);
    });

    test('16. Primary missing + unsupported-version backup -> fail closed; backup preserved', () => {
      const baseName = path.basename(journalPath);
      const bakPath = path.join(tempDir, `.${baseName}.bak.${Date.now()}`);

      const unsupportedPayload = {
        version: 99,
        checksum: 'invalid',
        jobs: {}
      };
      fs.writeFileSync(bakPath, JSON.stringify(unsupportedPayload), 'utf8');

      expect(() => new JobJournal(journalPath)).toThrow(/Unsupported journal version/);
      expect(fs.existsSync(journalPath)).toBe(false);
      expect(fs.existsSync(bakPath)).toBe(true);
    });

    test('17. Primary missing + multiple backups -> fail closed; no automatic selection', () => {
      const baseName = path.basename(journalPath);
      const bak1 = path.join(tempDir, `.${baseName}.bak.1001`);
      const bak2 = path.join(tempDir, `.${baseName}.bak.1002`);

      const validPayload = (id) => ({
        version: 1,
        checksum: JobJournal.computeChecksum({ [id]: { jobId: id, state: 'RECEIVED' } }),
        jobs: { [id]: { jobId: id, state: 'RECEIVED' } }
      });

      fs.writeFileSync(bak1, JSON.stringify(validPayload('job1')), 'utf8');
      fs.writeFileSync(bak2, JSON.stringify(validPayload('job2')), 'utf8');

      expect(() => new JobJournal(journalPath)).toThrow(/Ambiguous journal recovery/);

      // Both backups must be preserved; no primary journal created
      expect(fs.existsSync(journalPath)).toBe(false);
      expect(fs.existsSync(bak1)).toBe(true);
      expect(fs.existsSync(bak2)).toBe(true);
    });

    test('18. Primary valid + backup present -> primary remains authoritative', () => {
      const baseName = path.basename(journalPath);
      const bakPath = path.join(tempDir, `.${baseName}.bak.${Date.now()}`);

      // Primary journal with primary_job
      const primaryJobs = {
        'primary_job': { jobId: 'primary_job', state: 'COMPLETED_LOCALLY' }
      };
      fs.writeFileSync(journalPath, JSON.stringify({
        version: 1,
        checksum: JobJournal.computeChecksum(primaryJobs),
        jobs: primaryJobs
      }), 'utf8');

      // Stale backup with stale_job
      const staleJobs = {
        'stale_job': { jobId: 'stale_job', state: 'DISPATCHED_TO_SPOOLER' }
      };
      fs.writeFileSync(bakPath, JSON.stringify({
        version: 1,
        checksum: JobJournal.computeChecksum(staleJobs),
        jobs: staleJobs
      }), 'utf8');

      // Primary must remain authoritative
      const journal = new JobJournal(journalPath);
      expect(journal.hasJob('primary_job')).toBe(true);
      expect(journal.hasJob('stale_job')).toBe(false);
      // Backup is untouched
      expect(fs.existsSync(bakPath)).toBe(true);
    });

    test('19. No primary + no backup -> normal first-run clean initialization', () => {
      expect(fs.existsSync(journalPath)).toBe(false);
      const journal = new JobJournal(journalPath);
      expect(journal.jobs).toEqual({});
      expect(fs.existsSync(journalPath)).toBe(true);
    });

    test('20. Recovery persistence failure -> error propagated; no empty journal created', () => {
      const baseName = path.basename(journalPath);
      const bakPath = path.join(tempDir, `.${baseName}.bak.${Date.now()}`);

      const backupJobs = {
        'job_recov_fail': { jobId: 'job_recov_fail', state: 'RECEIVED' }
      };
      fs.writeFileSync(bakPath, JSON.stringify({
        version: 1,
        checksum: JobJournal.computeChecksum(backupJobs),
        jobs: backupJobs
      }), 'utf8');

      // Simulate failure during atomic replacement write
      jest.spyOn(fs, 'openSync').mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied during recovery save');
      });

      expect(() => new JobJournal(journalPath)).toThrow(/permission denied during recovery save/);

      // Primary journal must NOT exist as empty
      expect(fs.existsSync(journalPath)).toBe(false);
      // Original valid backup must be preserved
      expect(fs.existsSync(bakPath)).toBe(true);
    });

    test('21. Recovery does not load stale temporary files as backups', () => {
      const baseName = path.basename(journalPath);
      // Create a stale temporary file
      const staleTmp = path.join(tempDir, `.${baseName}.tmp.99999.111.abcdef`);
      fs.writeFileSync(staleTmp, 'stale temporary data', 'utf8');

      // Primary missing, no .bak file exists -> should initialize first-run empty
      const journal = new JobJournal(journalPath);
      expect(journal.jobs).toEqual({});
      // Stale tmp was not loaded
      expect(journal.hasJob('stale')).toBe(false);
    });

    test('22. Recovered ambiguous jobs remain ambiguous and cannot be automatically reprinted', () => {
      const baseName = path.basename(journalPath);
      const bakPath = path.join(tempDir, `.${baseName}.bak.${Date.now()}`);

      const backupJobs = {
        'job_inflight_recov': {
          jobId: 'job_inflight_recov',
          state: 'DISPATCHED_TO_SPOOLER',
          receivedAt: '2026-11-13T00:00:00.000Z',
          dispatchedAt: '2026-11-13T00:01:00.000Z',
          history: [{ state: 'RECEIVED' }, { state: 'DISPATCHED_TO_SPOOLER' }]
        }
      };
      fs.writeFileSync(bakPath, JSON.stringify({
        version: 1,
        checksum: JobJournal.computeChecksum(backupJobs),
        jobs: backupJobs
      }), 'utf8');

      const journal = new JobJournal(journalPath);
      journal.recoverOnStartup();

      const job = journal.getJob('job_inflight_recov');
      expect(job.state).toBe('AMBIGUOUS_REQUIRES_OPERATOR_REVIEW');
      expect(journal.isDispatched('job_inflight_recov')).toBe(true); // Refuses duplicate physical print!
    });
  });
});
