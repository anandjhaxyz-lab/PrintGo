const fs = require('fs');
const path = require('path');
const { runProvisioning } = require('../src/provision');
const JobJournal = require('../src/journal');

describe('Printer Agent Provisioning & Lifecycle Matrix', () => {
  const sandboxDir = path.join(__dirname, 'sandbox_provision');
  const dataDir = path.join(sandboxDir, 'data');
  const keysDir = path.join(sandboxDir, 'keys');
  const journalPath = path.join(dataDir, 'jobs.journal.json');
  const markerPath = path.join(dataDir, '.installation_marker');

  beforeEach(() => {
    if (fs.existsSync(sandboxDir)) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(keysDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(sandboxDir)) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  // 1. Genuine fresh installation
  test('1. Genuine fresh installation creates valid marker and initial journal', () => {
    const res = runProvisioning({ dataDir, keysDir, checkKeys: false });
    expect(res.success).toBe(true);
    expect(res.code).toBe('FRESH_PROVISIONED');
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(journalPath)).toBe(true);

    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(marker.installationId).toBeDefined();
    expect(marker.provisionedAt).toBeDefined();
    expect(marker.schemaVersion).toBe(1);

    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    expect(journal.version).toBe(2);
    expect(journal.jobs).toEqual({});
  });

  // 2. Existing machine with missing marker
  test('2. Existing machine with missing marker refuses normal provisioning and protects data', () => {
    // Journal exists with history, but marker was lost/deleted
    fs.writeFileSync(journalPath, JSON.stringify({ version: 1, jobs: { job_unanchored: { state: 'RECEIVED' } } }));

    const res = runProvisioning({ dataDir, keysDir, checkKeys: false });
    expect(res.success).toBe(false);
    expect(res.code).toBe('JOURNAL_EXISTS_UNANCHORED');

    // Customer job remains intact
    const content = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    expect(content.jobs.job_unanchored).toBeDefined();
    expect(content.jobs.job_unanchored.state).toBe('RECEIVED');
  });

  // 3. Existing machine with missing journal
  test('3. Existing machine with missing journal fails closed and blocks normal provisioning', () => {
    // Marker exists (or keys exist), but journal is deleted
    fs.writeFileSync(markerPath, JSON.stringify({ installationId: 'existing-uuid-missing-j' }));

    const res = runProvisioning({ dataDir, keysDir, checkKeys: false });
    expect(res.success).toBe(false);
    expect(res.code).toBe('EXISTING_INSTALL_MISSING_JOURNAL');
    expect(fs.existsSync(journalPath)).toBe(false);

    // Normal agent startup also fails closed
    const agentJournal = new JobJournal(journalPath, { markerPath, keysDir, checkKeys: false });
    expect(agentJournal.isCorrupted).toBe(true);
    expect(agentJournal.corruptionReason).toContain('Existing installation detected, but journal file is missing');
  });

  // 4. Existing machine with missing private key
  test('4. Existing machine with missing private key maintains journal integrity and backfills keys on startup', () => {
    // Machine has valid marker and journal, but keys/private.pem was not generated yet
    fs.writeFileSync(markerPath, JSON.stringify({ installationId: 'existing-uuid-nokey', schemaVersion: 1 }));
    fs.writeFileSync(journalPath, JSON.stringify({ version: 1, jobs: { job_p1: { state: 'PRINTING' } } }));

    // Provisioning is safely refused because valid installation is already active
    const res = runProvisioning({ dataDir, keysDir, checkKeys: true });
    expect(res.success).toBe(false);
    expect(res.code).toBe('ALREADY_PROVISIONED');

    // Normal agent startup loads the journal successfully
    const agentJournal = new JobJournal(journalPath, { markerPath, keysDir, checkKeys: true });
    expect(agentJournal.isCorrupted).toBe(false);
    expect(agentJournal.getJob('job_p1').state).toBe('PRINTING');
  });

  // 5. All identity anchors missing (unprovisioned machine on normal startup)
  test('5. All identity anchors missing fails closed on normal startup with 0 files created', () => {
    // Both marker and journal missing, normal startup (isProvisioning = false)
    const agentJournal = new JobJournal(journalPath, { markerPath, keysDir, checkKeys: false, isProvisioning: false });
    expect(agentJournal.isCorrupted).toBe(true);
    expect(agentJournal.corruptionReason).toContain('Unprovisioned installation');
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  // 6. Existing installation with outstanding job history
  test('6. Existing installation with outstanding job history is protected from repeated normal provisioning', () => {
    // Step 1: Initial fresh provision
    runProvisioning({ dataDir, keysDir, checkKeys: false });
    const initialMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));

    // Step 2: Record outstanding jobs in various states
    const j = new JobJournal(journalPath, { markerPath, keysDir, checkKeys: false });
    j.recordReceived('job_hist_1', { doc: 'doc1.pdf' });
    j.recordDispatchIntent('job_hist_2', { printer: 'Epson' });

    // Step 3: Run normal provisioning again
    const res = runProvisioning({ dataDir, keysDir, checkKeys: false });
    expect(res.success).toBe(false);
    expect(res.code).toBe('ALREADY_PROVISIONED');

    // Verification: Job history preserved intact
    const afterMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(afterMarker.installationId).toBe(initialMarker.installationId);
    const afterJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    expect(afterJournal.jobs.job_hist_1.state).toBe('RECEIVED');
    expect(afterJournal.jobs.job_hist_2.state).toBe('DISPATCH_INTENT');
  });

  // 7. Normal OTA restart
  test('7. Normal OTA process restart preserves existing journal and marker intact', () => {
    // Pre-populate journal with job in progress
    runProvisioning({ dataDir, keysDir, checkKeys: false });
    const j1 = new JobJournal(journalPath, { markerPath, keysDir, checkKeys: false });
    j1.recordReceived('job_ota_1', { doc: 'ota.pdf' });
    j1.recordDispatchIntent('job_ota_1', { printer: 'Epson' });

    const markerBefore = JSON.parse(fs.readFileSync(markerPath, 'utf8'));

    // Simulate OTA update: git pull, npm install, pm2 restart PrintGo_Agent
    // The restarted process instantiates JobJournal normally without any provisioning flags:
    const jRestarted = new JobJournal(journalPath, { markerPath, keysDir, checkKeys: false });
    expect(jRestarted.isCorrupted).toBe(false);
    expect(jRestarted.isExistingInstallation()).toBe(true);

    const markerAfter = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(markerAfter.installationId).toBe(markerBefore.installationId);

    const activeJob = jRestarted.getJob('job_ota_1');
    expect(activeJob).toBeDefined();
    expect(activeJob.state).toBe('DISPATCH_INTENT');
  });

  // 8. Unauthorized force-reprovision
  test('8. Unauthorized force-reprovision (casual --force, direct CLI, or bypass) is strictly rejected', () => {
    // 8A: Casual '--force' rejected
    const resA = runProvisioning({ dataDir, keysDir, checkKeys: false, args: ['--force'] });
    expect(resA.success).toBe(false);
    expect(resA.code).toBe('CASUAL_FORCE_REJECTED');

    // 8B: '--force-reprovision' without operator authorization rejected
    const resB = runProvisioning({ dataDir, keysDir, checkKeys: false, args: ['--force-reprovision'] });
    expect(resB.success).toBe(false);
    expect(resB.code).toBe('UNAUTHORIZED_FORCE_REPROVISION');

    // 8C: '--force-reprovision --confirm' non-interactive CLI bypass attempt rejected
    const resC = runProvisioning({ dataDir, keysDir, checkKeys: false, args: ['--force-reprovision', '--confirm'] });
    expect(resC.success).toBe(false);
    expect(resC.code).toBe('UNAUTHORIZED_FORCE_REPROVISION');
  });

  // 9. Interactive authorized force-reprovision
  test('9. Interactive authorized force-reprovision resets marker with new UUID and initializes clean journal', () => {
    // Initial setup with old data
    fs.writeFileSync(markerPath, JSON.stringify({ installationId: 'old-uuid-999', provisionedAt: '2025-01-01' }));
    fs.writeFileSync(journalPath, JSON.stringify({ version: 1, jobs: { old_job: { state: 'PRINTING' } } }));

    // Simulate operator confirming YES in provision_agent.bat
    process.env.AGENT_REPROVISION_AUTH = 'AUTHORIZED_BY_OPERATOR';

    const res = runProvisioning({
      dataDir,
      keysDir,
      checkKeys: false,
      args: ['--force-reprovision']
    });

    // Verification: Succeeded and environment variable scrubbed
    expect(res.success).toBe(true);
    expect(res.code).toBe('FORCE_REPROVISIONED');
    expect(process.env.AGENT_REPROVISION_AUTH).toBeUndefined();

    const newMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(newMarker.installationId).not.toBe('old-uuid-999');
    expect(newMarker.schemaVersion).toBe(1);

    const newJournal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    expect(newJournal.jobs).toEqual({});
  });
});
