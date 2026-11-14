require('dotenv').config();
const { io } = require('socket.io-client');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');
const { exec, execFile } = require('child_process');
const execFileAsync = util.promisify(execFile);
const crypto = require('crypto');
const forge = require('node-forge');
let pdfParse;
try {
  const pdfModule = require('pdf-parse');
  // pdf-parse v2 exports { PDFParse } class, v1 exports a function directly
  pdfParse = typeof pdfModule === 'function' ? pdfModule : null;
} catch(e) {
  pdfParse = null;
}
const SpoolerMonitor = require('./src/spooler');
const JobJournal = require('./src/journal');
const printMutex = require('./src/printMutex');

let journal;
try {
  journal = new JobJournal();
  journal.recoverOnStartup();
  console.log(`📖 Job Journal initialized and verified (${Object.keys(journal.jobs).length} tracked jobs).`);

  // P1-01: On restart, if any job is still in an ambiguous or in-flight state
  // in the journal, permanently lock the mutex to prevent another physical
  // print until an operator clears the ambiguous state.
  const inFlightStates = ['DISPATCHED_TO_SPOOLER', 'SPOOLING', 'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW'];
  const ambiguousJob = Object.values(journal.jobs).find(j => inFlightStates.includes(j.state));
  if (ambiguousJob) {
    printMutex.lockForAmbiguous(ambiguousJob.jobId);
    console.warn(`⚠️ P1-01: Startup mutex locked for ambiguous/in-flight job ${ambiguousJob.jobId} (state: ${ambiguousJob.state}). Physical printing disabled until operator clears this job.`);
  }
} catch (err) {
  console.error(`🔥 FATAL ERROR: Journal integrity check failed: ${err.message}`);
  console.error(`Agent cannot operate with a corrupt or unreadable journal. Halting startup.`);
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  console.error('🔥 CRITICAL ERROR: Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 CRITICAL ERROR: Unhandled Rejection at:', promise, 'reason:', reason);
});

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:5000';
const PRINTER_NAME = process.env.PRINTER_NAME || null; 
const MACHINE_KEY = process.env.MACHINE_KEY;

if (!MACHINE_KEY) {
  console.error('🔥 FATAL ERROR: MACHINE_KEY is not defined in .env');
  process.exit(1);
}

if (PRINTER_NAME && !/^[a-zA-Z0-9_\-\s\(\)\.]+$/.test(PRINTER_NAME)) {
  console.error('🔥 FATAL ERROR: PRINTER_NAME contains invalid characters. Only alphanumeric, space, underscore, dash, and parentheses are allowed.');
  process.exit(1);
}

// P3-003: Printer Compatibility & Driver Validation
async function validatePrinter() {
    if (PRINTER_NAME === 'SimulationMode') {
        console.log(`\n🖨️  Running in SIMULATION MODE. Skipping printer validation.`);
        return;
    }
    try {
        if (os.platform() === 'win32') {
            await execFileAsync('powershell.exe', ['-Command', `Get-Printer -Name '${PRINTER_NAME}' -ErrorAction Stop | Select-Object Name`]);
            console.log(`\n✅ Validated local Windows printer: ${PRINTER_NAME}`);
        } else {
            await execFileAsync('lpstat', ['-p', PRINTER_NAME]);
            console.log(`\n✅ Validated local CUPS printer: ${PRINTER_NAME}`);
        }
    } catch (error) {
        console.error(`\n🔥 FATAL ERROR: Printer '${PRINTER_NAME}' does not exist on this machine.`);
        console.error(`Please verify the PRINTER_NAME in .env matches exactly.\n`);
        process.exit(1);
    }
}

if (PRINTER_NAME) {
    validatePrinter();
} else {
  console.warn('⚠️  WARNING: PRINTER_NAME is not set. Running in simulation mode (no physical printing).');
}

console.log(`🖨️  PrintGo Enterprise Printer Agent Starting...`);
console.log(`🔗 Connecting to cloud backend: ${BACKEND_URL}`);

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

const socket = io(BACKEND_URL, { 
  transports: ['websocket'],
  auth: { machineKey: MACHINE_KEY }
});

// Persistent RSA Keypair for E2EE across restarts
const keysDir = path.join(__dirname, 'keys');
if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });

const pubKeyPath = path.join(keysDir, 'public.pem');
const privKeyPath = path.join(keysDir, 'private.pem');

let publicKeyPem;
let privateKeyPem;

if (fs.existsSync(pubKeyPath) && fs.existsSync(privKeyPath)) {
  console.log('🔐 Loading existing RSA Keypair for E2EE...');
  publicKeyPem = fs.readFileSync(pubKeyPath, 'utf8');
  privateKeyPem = fs.readFileSync(privKeyPath, 'utf8');
  console.log('✅ Keys loaded from disk.');
} else {
  console.log('🔐 Generating persistent RSA-OAEP Keypair for End-to-End Encryption...');
  const rsaKeypair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  publicKeyPem = forge.pki.publicKeyToPem(rsaKeypair.publicKey);
  privateKeyPem = forge.pki.privateKeyToPem(rsaKeypair.privateKey);
  fs.writeFileSync(pubKeyPath, publicKeyPem, 'utf8');
  fs.writeFileSync(privKeyPath, privateKeyPem, 'utf8');
  console.log('✅ New persistent keys generated and saved to disk.');
}

const spoolerMonitor = new SpoolerMonitor({ execFile, printerName: PRINTER_NAME, journal });

let statusInterval = null;
socket.on('connect', () => {
  console.log(`✅ Connected to cloud backend! (Socket ID: ${socket.id})`);
  
  // Register Public Key with Backend for E2EE
  socket.emit('register_public_key', { publicKey: publicKeyPem });
  
  // Clear any previous interval to prevent leaks on reconnect
  if (statusInterval) clearInterval(statusInterval);
  
  // Periodically send printer status
  statusInterval = setInterval(() => {
    spoolerMonitor.checkPrinterStatus(socket);
  }, 30000); // every 30s
});

socket.on('printer_registration_failed', (data) => {
  console.error('❌ Registration Failed:', data.error);
  process.exit(1);
});

socket.on('printer_registered_success', (data) => {
  console.log(`✅ Registration Success. Machine: ${data.name}`);
});

socket.on('machine_suspended', (data) => {
  console.error(`❌ MACHINE SUSPENDED: ${data.message}`);
  console.error(`Stopping printer agent...`);
  process.exit(1);
});

socket.on('disconnect', () => {
  console.log(`❌ Disconnected from backend. Attempting to reconnect...`);
});

socket.on('connect_error', (err) => {
  console.error(`🔌 Connection Error: ${err.message}`);
});

socket.on('ack_job_completed', ({ jobId }) => {
  console.log(`✅ Backend acknowledged completion for Job ${jobId}`);
  journal.recordAcknowledged(jobId);
});

/**
 * P1-02 Reconnect Reconciliation Helper
 *
 * Verifies whether a journal entry contains genuine durable terminal evidence
 * of physical print completion:
 * - Must be COMPLETED_LOCALLY
 * - If simulation mode was recorded, it is genuine simulation completion.
 * - For physical printing: must have details.wasSeenInQueue === true.
 * - Missing or falsy wasSeenInQueue does NOT qualify (rejects fast-clear / unverified paths).
 */
function hasVerifiedTerminalCompletion(entry) {
  if (!entry || entry.state !== 'COMPLETED_LOCALLY') {
    return false;
  }

  // Check details recorded in the journal entry or entry history
  const details = entry.details || {};

  // If simulation mode
  if (details.mode === 'simulation') {
    return true;
  }

  // Must have strict wasSeenInQueue === true
  if (details.wasSeenInQueue === true) {
    return true;
  }

  // Inspect history records for terminal evidence
  if (Array.isArray(entry.history)) {
    const completedStep = entry.history.find(h => h.state === 'COMPLETED_LOCALLY');
    if (completedStep && completedStep.details) {
      if (completedStep.details.mode === 'simulation') return true;
      if (completedStep.details.wasSeenInQueue === true) return true;
    }
  }

  return false;
}

socket.on('reconcile_active_jobs', ({ jobIds = [] }) => {
  console.log(`🔍 Received reconciliation request from backend for jobs:`, jobIds);
  for (const jobId of jobIds) {
    const entry = journal.getJob(jobId);
    if (!entry) {
      console.warn(`📡 Job ${jobId} not found in agent journal during reconciliation.`);
      socket.emit('job_reconciliation_report', { jobId, status: 'NOT_DISPATCHED' });
      continue;
    }

    if (entry.state === 'ACKNOWLEDGED') {
      // P1-02: Already acknowledged terminal completion. Emit idempotent terminal success.
      console.log(`📡 Job ${jobId} already ACKNOWLEDGED in journal. Emitting idempotent success.`);
      socket.emit('print_physical_success', {
        jobId,
        reconciled: true,
        idempotent: true,
        wasSeenInQueue: true,
        dispatchedAt: entry.dispatchedAt,
        completedAt: entry.completedAt
      });
    } else if (entry.state === 'COMPLETED_LOCALLY') {
      // P1-02: Check for genuine verified durable evidence
      if (hasVerifiedTerminalCompletion(entry)) {
        console.log(`📡 Reporting verified terminal physical completion for Job ${jobId}`);
        socket.emit('print_physical_success', {
          jobId,
          reconciled: true,
          wasSeenInQueue: true,
          dispatchedAt: entry.dispatchedAt,
          completedAt: entry.completedAt
        });
      } else {
        // Missing wasSeenInQueue or fastSpoolCleared without queue observation -> report ambiguous!
        console.warn(`⚠️ Reporting AMBIGUOUS for Job ${jobId}: COMPLETED_LOCALLY lacks reliable wasSeenInQueue evidence.`);
        socket.emit('print_physical_ambiguous', {
          jobId,
          reason: 'Reconciliation: COMPLETED_LOCALLY lacks verified wasSeenInQueue evidence',
          wasSeenInQueue: false
        });
      }
    } else if (
      entry.state === 'DISPATCHED_TO_SPOOLER' ||
      entry.state === 'SPOOLING' ||
      entry.state === 'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW'
    ) {
      // P1-02: Non-terminal in-flight states must NEVER emit print_physical_success
      console.warn(`⚠️ Reporting AMBIGUOUS for Job ${jobId}: Agent state is ${entry.state}. Physical completion unverified.`);
      socket.emit('print_physical_ambiguous', {
        jobId,
        reason: `Reconciliation: Job in unverified state ${entry.state}`,
        wasSeenInQueue: entry.state === 'SPOOLING'
      });
      // Also emit job_reconciliation_report for legacy diagnostic logging
      socket.emit('job_reconciliation_report', { jobId, status: entry.state });
    } else {
      console.log(`📡 Job ${jobId} in state ${entry.state}; not dispatched or completed.`);
      socket.emit('job_reconciliation_report', { jobId, status: entry.state });
    }
  }
});

// checkPrinterStatus logic has been moved to src/spooler.js

socket.on('physical_print_job', async (jobData) => {
  // Command Injection Prevention (P0)
  if (!jobData.jobId || !/^[a-zA-Z0-9_-]+$/.test(jobData.jobId)) {
    console.error(`❌ REJECTED Job: Invalid jobId format (potential injection): ${jobData.jobId}`);
    return;
  }

  // Idempotency Guard (P0) - Never re-print a previously dispatched job!
  if (journal.isDispatched(jobData.jobId)) {
    const existing = journal.getJob(jobData.jobId);
    if (existing && existing.state === 'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW') {
      console.error(`❌ REFUSING PRINT: Job ${jobData.jobId} is AMBIGUOUS_REQUIRES_OPERATOR_REVIEW. Physical reprinting is blocked.`);
      socket.emit('print_spooler_error', { jobId: jobData.jobId, error: 'Job is ambiguous across restart; automatic reprint blocked' });
      return;
    }
    console.warn(`⚠️ IDEMPOTENCY GUARD: Job ${jobData.jobId} was already dispatched/printed locally. Refusing duplicate physical print!`);
    socket.emit('print_physical_success', { jobId: jobData.jobId, alreadyDispatched: true });
    return;
  }

  // P1-01: Serialization Gate — log if the mutex is already held before queueing
  if (printMutex.isLocked()) {
    console.warn(`⚠️ P1-01 SERIALIZATION: Job ${jobData.jobId} queued — printer is busy with job ${printMutex.getHeldJobId()}. Waiting for lock...`);
  }

  // Record receipt before entering queue (safe — not yet physical dispatch)
  journal.recordReceived(jobData.jobId, { originalName: jobData.originalName });

  // P1-01: Acquire the serialization lock. This call queues behind any
  // in-progress physical print job and waits until the lock is released.
  // A second concurrent call will suspend here until job A completes.
  let lockHandle;
  try {
    lockHandle = await printMutex.acquire(jobData.jobId);
  } catch (lockErr) {
    console.error(`❌ P1-01: Failed to acquire serialization lock for Job ${jobData.jobId}: ${lockErr.message}`);
    socket.emit('print_spooler_error', { jobId: jobData.jobId, error: 'Serialization lock acquisition failed' });
    return;
  }

  // Re-check idempotency after lock acquisition (another job may have finished and
  // the same jobId could have been re-submitted as a duplicate during the wait)
  if (journal.isDispatched(jobData.jobId)) {
    const existing = journal.getJob(jobData.jobId);
    if (existing && existing.state === 'AMBIGUOUS_REQUIRES_OPERATOR_REVIEW') {
      console.error(`❌ REFUSING PRINT (post-lock): Job ${jobData.jobId} is AMBIGUOUS_REQUIRES_OPERATOR_REVIEW.`);
      socket.emit('print_spooler_error', { jobId: jobData.jobId, error: 'Job is ambiguous; automatic reprint blocked' });
      lockHandle.release();
      return;
    }
    console.warn(`⚠️ IDEMPOTENCY GUARD (post-lock): Job ${jobData.jobId} was already dispatched. Refusing duplicate.`);
    socket.emit('print_physical_success', { jobId: jobData.jobId, alreadyDispatched: true });
    lockHandle.release();
    return;
  }

  console.log(`\n======================================================`);
  console.log(`📥 NEW PRINT JOB RECEIVED! [Job ID: ${jobData.jobId}]`);
  console.log(`📄 Document: ${jobData.originalName}`);
  console.log(`🔒 P1-01: Serialization lock acquired for Job ${jobData.jobId}`);
  console.log(`======================================================`);

  let fileUrl = jobData.fileUrl;
  if (fileUrl && fileUrl.startsWith('https://localhost:5000')) {
    fileUrl = fileUrl.replace('https://localhost:5000', BACKEND_URL);
  } else if (fileUrl && !fileUrl.startsWith('http')) {
    fileUrl = `${BACKEND_URL}${fileUrl.startsWith('/') ? '' : '/'}${fileUrl}`;
  }

  // Extract original extension (default to .pdf if missing)
  const ext = jobData.originalName ? path.extname(jobData.originalName) : '.pdf';
  const localFilePath = path.join(tempDir, `${jobData.jobId}${ext}`);
  let printFilePath = localFilePath;

  try {
    console.log(`⬇️  Downloading PDF from cloud...`);
    const response = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'arraybuffer', // Get as buffer for decryption
      headers: { 'x-machine-key': MACHINE_KEY }
    });

    let fileBuffer = response.data;

    // E2E Decryption & Page Verification
    if (jobData.encryptedKey && jobData.iv) {
      console.log(`🔒 Encrypted job detected. Decrypting...`);
      try {
        // 1. Decrypt AES Key using RSA Private Key
        const encryptedKeyBuffer = Buffer.from(jobData.encryptedKey, 'base64');
        const decryptedKey = crypto.privateDecrypt(
          {
            key: privateKeyPem,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
          },
          encryptedKeyBuffer
        );

        // 2. Decrypt File Payload using AES-GCM
        const decipher = crypto.createDecipheriv('aes-256-gcm', decryptedKey, Buffer.from(jobData.iv, 'base64'));

        // Extract Auth Tag (last 16 bytes)
        const authTag = fileBuffer.slice(-16);
        const encryptedData = fileBuffer.slice(0, -16);

        decipher.setAuthTag(authTag);

        const decryptedBuffer = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
        fileBuffer = decryptedBuffer;

        console.log(`✅ Decryption successful. Validating page count...`);

        // 3. Verify Page Count (Fraud Protection) - Only for PDFs
        const isPdf = fileBuffer.length > 5 && fileBuffer.toString('utf8', 0, 5) === '%PDF-';
        const claimedPages = jobData.pagesToPrint || 1;

        if (isPdf && pdfParse) {
          const pdfData = await pdfParse(fileBuffer);
          const actualPages = pdfData.numpages;

          if (actualPages > claimedPages) {
            throw new Error(`Fraud detected! Claimed pages: ${claimedPages}, Actual pages: ${actualPages}`);
          }
          console.log(`📄 Page count validated (${actualPages} pages).`);
        } else if (isPdf) {
          console.log(`⚠️  pdf-parse unavailable, skipping page count validation.`);
        } else {
          console.log(`🖼️ Image detected. Bypassing PDF page validation.`);
        }
      } catch (decErr) {
        throw new Error(`Security Exception: ${decErr.message}`);
      }
    }

    fs.writeFileSync(localFilePath, fileBuffer);
    console.log(`✅ File saved to disk. Validating format...`);

    const isWin = os.platform() === 'win32';

    // Convert Office formats to PDF if on Linux (Raspberry Pi)
    if (!isWin) {
      const officeExtensions = ['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt'];
      if (officeExtensions.includes(ext.toLowerCase())) {
        console.log(`🔄 Converting ${ext} to PDF using LibreOffice...`);
        try {
          await execFileAsync('libreoffice', [
            '--headless',
            '--convert-to',
            'pdf',
            localFilePath,
            '--outdir',
            tempDir
          ]);
          printFilePath = path.join(tempDir, `${jobData.jobId}.pdf`);
          console.log(`✅ Conversion successful: ${printFilePath}`);
          // Delete the original Office document to save space
          if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
        } catch (err) {
          console.error(`⚠️ LibreOffice conversion failed: ${err.message}`);
          throw new Error(`Failed to convert ${ext} document for printing. Please ensure LibreOffice is installed.`);
        }
      }
    }

    if (PRINTER_NAME) {
      if (isWin) {
        const ptp = require('pdf-to-printer');
        const printOptions = { printer: PRINTER_NAME };

        if (jobData.settings) {
          if (jobData.settings.copies) printOptions.copies = jobData.settings.copies;
          // Set monochrome: true for B&W, false for explicit color flag in SumatraPDF
          printOptions.monochrome = (jobData.settings.color === 'bw');
          // Set side: 'duplex' for double-sided, 'simplex' for single-sided
          printOptions.side = (jobData.settings.duplex === 'double') ? 'duplex' : 'simplex';
          if (jobData.settings.pageRangeType === 'custom' && jobData.settings.customRange) {
            if (/^[0-9,-]+$/.test(jobData.settings.customRange)) {
              printOptions.pages = jobData.settings.customRange;
            } else {
              console.error(`⚠️  WARNING: Invalid customRange input detected: ${jobData.settings.customRange}. Ignoring.`);
            }
          }
        }

        console.log(`⚙️  Windows Print options:`, JSON.stringify(printOptions));
        journal.recordDispatched(jobData.jobId, { printerName: PRINTER_NAME, settings: jobData.settings });
        await ptp.print(printFilePath, printOptions);
      } else {
        // Linux CUPS Support (Raspberry Pi)
        const args = ['-d', PRINTER_NAME, '-t', jobData.jobId];

        if (jobData.settings) {
          if (jobData.settings.copies) args.push('-n', String(jobData.settings.copies));
          if (jobData.settings.duplex === 'double') args.push('-o', 'sides=two-sided-long-edge');
          else args.push('-o', 'sides=one-sided');

          if (jobData.settings.pageRangeType === 'custom' && jobData.settings.customRange) {
            if (/^[0-9,-]+$/.test(jobData.settings.customRange)) {
              args.push('-P', String(jobData.settings.customRange));
            } else {
              console.error(`⚠️  WARNING: Invalid customRange input detected: ${jobData.settings.customRange}. Ignoring.`);
            }
          }
        }
        args.push(printFilePath);

        console.log(`⚙️  Linux Print command: lp ${args.join(' ')}`);
        journal.recordDispatched(jobData.jobId, { printerName: PRINTER_NAME, settings: jobData.settings });
        await execFileAsync('lp', args);
      }

      console.log(`🖨️  SUCCESS: Job ${jobData.jobId} sent to Print Spooler!`);

      // Notify backend that spooler accepted the job
      socket.emit('print_spooler_success', { jobId: jobData.jobId });
    }

    // P3-001 / P1-01: Await terminal outcome from spooler monitor.
    // Lock release decision is made based on outcome:
    //   resolved → verified terminal success → release lock for next job
    //   rejected with isAmbiguous=true → lock printer permanently (operator required)
    //   rejected with isAmbiguous=false → definite error, safe to release lock
    try {
      await spoolerMonitor.startPollingJob(jobData.jobId, printFilePath, socket);
      console.log(`🔓 P1-01: Releasing serialization lock after verified completion of Job ${jobData.jobId}`);
      lockHandle.release();
    } catch (spoolerErr) {
      if (spoolerErr.isAmbiguous) {
        console.error(`🔥 P1-01: Ambiguous outcome for Job ${jobData.jobId} — permanently locking printer. Operator review required.`);
        printMutex.lockForAmbiguous(jobData.jobId);
        // lockHandle is superseded by lockForAmbiguous; do NOT call lockHandle.release()
      } else {
        // Definite error (physical printer error) — release lock so next job can proceed
        console.warn(`⚠️ P1-01: Definite error for Job ${jobData.jobId} — releasing lock for next job.`);
        lockHandle.release();
      }
    }

  } catch (error) {
    // Pre-dispatch error (download, decrypt, file write, lp/ptp.print call failed)
    // The physical printer was never successfully contacted → safe to release lock
    console.error(`❌ ERROR processing Job ${jobData.jobId}:`, error.message);
    socket.emit('print_spooler_error', { jobId: jobData.jobId, error: error.message });
    if (fs.existsSync(localFilePath)) {
      try { fs.unlinkSync(localFilePath); } catch (_) {}
    }
    if (printFilePath !== localFilePath && fs.existsSync(printFilePath)) {
      try { fs.unlinkSync(printFilePath); } catch (_) {}
    }
    lockHandle.release();
  }
});

// Send heartbeat every 30 seconds to keep machine online status active
setInterval(() => {
  socket.emit('heartbeat');
}, 30000);

// P4-001: Render Free Tier Keep-Alive
// Render spins down free instances after 15 mins of inactivity. 
// A raw HTTP GET request every 10 minutes ensures the server stays awake while the kiosk is online.
setInterval(async () => {
  try {
    await axios.get(`${BACKEND_URL}/api/health`);
    console.log(`📡 Keep-Alive ping sent to ${BACKEND_URL}/api/health`);
  } catch (error) {
    console.error(`⚠️  Keep-Alive ping failed: ${error.message}`);
  }
}, 10 * 60 * 1000); // 10 minutes
