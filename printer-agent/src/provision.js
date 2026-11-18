const fs = require('fs');
const path = require('path');
const JobJournal = require('./journal');

function runProvisioning(options = {}) {
  const args = options.args || process.argv.slice(2);
  const dataDir = options.dataDir || path.join(__dirname, '../data');
  const journalPath = options.journalPath || path.join(dataDir, 'jobs.journal.json');
  const markerPath = options.markerPath || path.join(dataDir, '.installation_marker');
  const keysDir = options.keysDir || path.join(__dirname, '../keys');

  const hasForceReprovision = args.includes('--force-reprovision') || !!options.forceReprovision;
  const hasCasualForce = args.includes('--force');

  // 1. Strictly reject casual '--force' alias
  if (hasCasualForce && !hasForceReprovision) {
    const msg = "Error: Casual '--force' flag is rejected. You must pass '--force-reprovision' explicitly for destructive reprovisioning.";
    if (options.throwOnError) throw new Error(msg);
    console.error(`\n❌ ${msg}\n`);
    return { success: false, code: 'CASUAL_FORCE_REJECTED', error: msg };
  }

  // 2. Check existing state
  const journalExists = fs.existsSync(journalPath);
  const markerExists = fs.existsSync(markerPath);
  const keysExist = fs.existsSync(path.join(keysDir, 'private.pem'));
  const isExisting = markerExists || keysExist;

  // 3. Force-reprovision handling
  if (hasForceReprovision) {
    // Strictly require authorized interactive execution via provision_agent.bat
    // or programmatic authorization in test harness
    const isAuthorized = (process.env.AGENT_REPROVISION_AUTH === 'AUTHORIZED_BY_OPERATOR') ||
                         options.confirm === true ||
                         options.authorized === true;

    // Immediately scrub authorization environment variable
    if (process.env.AGENT_REPROVISION_AUTH !== undefined) {
      delete process.env.AGENT_REPROVISION_AUTH;
    }

    if (!isAuthorized) {
      const msg = "Error: Destructive force-reprovisioning cannot be invoked directly or non-interactively. You must run provision_agent.bat --force-reprovision interactively and confirm with 'YES'.";
      if (options.throwOnError) throw new Error(msg);
      console.error(`\n❌ ${msg}\n`);
      return { success: false, code: 'UNAUTHORIZED_FORCE_REPROVISION', error: msg };
    }

    console.log('\n⚠️  EXECUTING AUTHORIZED FORCE-REPROVISION...');
    console.log('   Resetting installation marker and initializing fresh journal...');

    const journal = new JobJournal(journalPath, {
      markerPath,
      keysDir,
      checkKeys: options.checkKeys !== undefined ? options.checkKeys : true,
      isProvisioning: true,
      forceReprovision: true
    });

    if (journal.isCorrupted) {
      const msg = `Force-reprovision failed: ${journal.corruptionReason}`;
      if (options.throwOnError) throw new Error(msg);
      console.error(`\n❌ ${msg}\n`);
      return { success: false, code: 'PROVISION_FAILED', error: msg };
    }

    // Persist clean initial journal to disk
    journal.save();

    console.log(`✅ Force-reprovision successful.`);
    console.log(`   New Installation ID: ${journal.installationInfo?.installationId}`);
    return { success: true, code: 'FORCE_REPROVISIONED', installationId: journal.installationInfo?.installationId };
  }

  // 4. Normal provisioning on an existing installation: MUST REFUSE
  if (journalExists && isExisting) {
    const msg = `Refusing normal provisioning: An active PrintGo installation with valid journal and marker is already present at ${journalPath}. Customer data was preserved.`;
    if (options.throwOnError) throw new Error(msg);
    console.error(`\n❌ ${msg}\n`);
    return { success: false, code: 'ALREADY_PROVISIONED', error: msg };
  }

  if (isExisting && !journalExists) {
    const msg = `Refusing normal provisioning: Existing installation anchors detected (marker/keys exist) but journal file is missing. This machine failed closed to prevent duplicate prints. Operator must run '--force-reprovision' after clearing output tray.`;
    if (options.throwOnError) throw new Error(msg);
    console.error(`\n❌ ${msg}\n`);
    return { success: false, code: 'EXISTING_INSTALL_MISSING_JOURNAL', error: msg };
  }

  if (journalExists && !markerExists) {
    const msg = `Refusing normal provisioning: Existing journal file detected at ${journalPath}. To prevent overwriting customer history, normal provisioning is blocked.`;
    if (options.throwOnError) throw new Error(msg);
    console.error(`\n❌ ${msg}\n`);
    return { success: false, code: 'JOURNAL_EXISTS_UNANCHORED', error: msg };
  }

  // 5. Genuine fresh installation
  console.log('\n📦 Initializing genuine fresh PrintGo Agent installation...');
  const journal = new JobJournal(journalPath, {
    markerPath,
    keysDir,
    checkKeys: options.checkKeys !== undefined ? options.checkKeys : true,
    isProvisioning: true
  });

  if (journal.isCorrupted) {
    const msg = `Fresh provisioning failed: ${journal.corruptionReason}`;
    if (options.throwOnError) throw new Error(msg);
    console.error(`\n❌ ${msg}\n`);
    return { success: false, code: 'PROVISION_FAILED', error: msg };
  }

  // Persist the clean initial journal to disk so normal startup finds it
  journal.save();

  console.log(`✅ Genuine fresh provisioning completed successfully.`);
  console.log(`   Installation ID: ${journal.installationInfo?.installationId}`);
  console.log(`   Journal Created: ${journalPath}`);
  console.log(`   Marker Created:  ${markerPath}\n`);

  return { success: true, code: 'FRESH_PROVISIONED', installationId: journal.installationInfo?.installationId };
}

if (require.main === module) {
  const result = runProvisioning();
  process.exit(result.success ? 0 : 1);
}

module.exports = { runProvisioning };
