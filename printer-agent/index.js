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
const { PrinterFleetManager } = require('./src/printerFleetManager');
const { discoverWindowsPrinters } = require('./src/windowsPrinterDiscovery');
const {
  buildAgentHello,
  validatePrinterDeviceRegistry
} = require('./src/agentProtocol');
const journal = new JobJournal();
const agentPackage = require('./package.json');

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
let registeredMachineId = null;
let fleetProtocolAccepted = false;
let fleetManager = null;
socket.on('connect', () => {
  console.log(`✅ Connected to cloud backend! (Socket ID: ${socket.id})`);
  fleetProtocolAccepted = false;
  fleetManager = null;
  
  // Register Public Key with Backend for E2EE
  socket.emit('register_public_key', { publicKey: publicKeyPem });

  // Negotiate the additive fleet protocol. Older backends ignore this event;
  // the existing single-printer flow remains active in that case.
  socket.emit('printer_agent_hello', buildAgentHello({
    agentVersion: agentPackage.version,
    markerPath: journal.markerPath,
    journalSchemaVersion: 2
  }));
  
  // Clear any previous interval to prevent leaks on reconnect
  if (statusInterval) clearInterval(statusInterval);
  
  // Per-device monitoring is enabled only after a machine-bound registry is
  // validated. Until then, keep the legacy PRINTER_NAME status path unchanged.
  statusInterval = setInterval(() => {
    if (fleetManager && fleetManager.monitors.size > 0) {
      fleetManager.checkPrinterStatuses(socket);
    } else {
      spoolerMonitor.checkPrinterStatus(socket);
    }
  }, 30000); // every 30s
});

socket.on('printer_registration_failed', (data) => {
  console.error('❌ Registration Failed:', data.error);
  process.exit(1);
});

socket.on('printer_registered_success', (data) => {
  registeredMachineId = typeof data?.machineId === 'string' ? data.machineId : null;
  console.log(`✅ Registration Success. Machine: ${data.name}`);
});

socket.on('printer_agent_hello_ack', (ack) => {
  if (ack && typeof ack.machineId === 'string') {
    registeredMachineId = ack.machineId;
  }
  if (!ack || ack.accepted !== true) {
    fleetProtocolAccepted = false;
    console.warn(`⚠️ Multi-printer protocol not negotiated: ${ack?.reason || ack?.code || 'backend did not accept hello'}`);
    return;
  }

  fleetProtocolAccepted = ack.supportsMultiPrinter === true;
  if (fleetProtocolAccepted) {
    console.log(`✅ Multi-printer protocol v${ack.protocolVersion} accepted for Machine ${ack.machineId} (limit: ${ack.maxPrinters})`);
  } else {
    console.log('ℹ️ Backend accepted Agent hello; legacy single-printer mode remains active on this platform.');
  }
});

socket.on('printer_device_registry', async (payload) => {
  if (!fleetProtocolAccepted) {
    console.warn('⚠️ Ignoring PrinterDevice registry because multi-printer capability was not negotiated.');
    return;
  }

  try {
    const devices = validatePrinterDeviceRegistry(payload, registeredMachineId);
    const discoveredPrinters = await discoverWindowsPrinters({ execFile });

    const nextFleetManager = new PrinterFleetManager({
      maxDevices: 10,
      journal,
      discoverPrinters: async () => discoveredPrinters,
      getDeviceRegistry: async () => devices,
      monitorFactory: ({ printerDevice, printerName }) => new SpoolerMonitor({
        execFile,
        printerName,
        printerDeviceId: printerDevice.id,
        journal
      })
    });

    const fleet = await nextFleetManager.refresh();
    fleetManager = nextFleetManager;

    socket.emit('printer_inventory_report', {
      protocolVersion: 1,
      discoveredPrinters
    });

    const approvedCount = fleet.filter((device) => device.canPrint).length;
    console.log(`🖨️ Printer fleet synchronized: ${discoveredPrinters.length} Windows queue(s) discovered; ${approvedCount} approved device(s) have independent monitors.`);
  } catch (error) {
    // Fail closed: a bad registry or Windows inventory cannot enable a printer.
    fleetManager = null;
    console.error(`❌ Multi-printer registry synchronization failed: ${error.message}`);
  }
});

socket.on('printer_device_registry_error', (payload) => {
  console.warn(`⚠️ PrinterDevice registry unavailable: ${payload?.message || payload?.code || 'unknown error'}`);
});

socket.on('printer_inventory_report_ack', (ack) => {
  if (ack?.accepted) {
    console.log(`✅ Backend received discovery inventory: ${ack.receivedCount} queue(s).`);
  } else {
    console.warn(`⚠️ Backend rejected discovery inventory: ${ack?.message || ack?.code || 'unknown error'}`);
  }
});

socket.on('machine_suspended', (data) => {
  console.error(`❌ MACHINE SUSPENDED: ${data.message}`);
  console.error(`Stopping printer agent...`);
  process.exit(1);
});

socket.on('disconnect', () => {
  fleetProtocolAccepted = false;
  fleetManager = null;
  console.log(`❌ Disconnected from backend. Attempting to reconnect...`);
});

socket.on('connect_error', (err) => {
  console.error(`🔌 Connection Error: ${err.message}`);
});

socket.on('ack_job_completed', ({ jobId }) => {
  console.log(`✅ Backend acknowledged completion for Job ${jobId}`);
  journal.recordAcknowledged(jobId);
});

socket.on('reconcile_active_jobs', ({ requestId, jobIds = [] }) => {
  console.log(`🔍 Received reconciliation request [ReqID: ${requestId || 'legacy'}] from backend for jobs:`, jobIds);

  // FAIL-CLOSED GUARD: Corrupted, unreadable, or version-mismatched journal
  if (journal.isCorrupted) {
    console.error(`🔥 FAIL-CLOSED GUARD: Local journal is corrupted/unreadable (${journal.corruptionReason}). Refusing to report NOT_DISPATCHED!`);
    for (const jobId of jobIds) {
      socket.emit('print_physical_ambiguous', {
        jobId,
        requestId,
        reason: `Local journal corrupted/unreadable: ${journal.corruptionReason}. Manual verification required.`,
        wasSeenInQueue: false
      });
    }
    return;
  }

  for (const jobId of jobIds) {
    const entry = journal.getJob(jobId);
    if (!entry) {
      // Proved never recorded in local journal
      console.log(`📡 Job ${jobId} was never recorded in local journal.`);
      socket.emit('job_reconciliation_report', { requestId, jobId, status: 'NOT_DISPATCHED' });
    } else if (journal.isCorruptedEntry(entry)) {
      // Incomplete or malformed journal entry -> Fail closed as AMBIGUOUS
      console.warn(`⚠️ Incomplete/corrupted journal entry for Job ${jobId}. Reporting AMBIGUOUS.`);
      socket.emit('print_physical_ambiguous', {
        jobId,
        requestId,
        reason: 'Incomplete or malformed journal entry (missing required state)',
        wasSeenInQueue: false
      });
    } else if (entry.state === 'RECEIVED') {
      // Proved never dispatched to driver/spooler: safe to request re-dispatch
      console.log(`📡 Job ${jobId} was received but never dispatched to spooler locally.`);
      socket.emit('job_reconciliation_report', { requestId, jobId, status: 'NOT_DISPATCHED' });
    } else if (entry.state === 'DISPATCH_INTENT') {
      // Crash boundary: recorded intent to call driver, but spooler handoff unconfirmed.
      // Physical outcome unknown. Must classify as AMBIGUOUS to prevent duplicate physical print.
      console.warn(`⚠️ AMBIGUOUS DISPATCH: Job ${jobId} crashed during dispatch intent window. Reporting ambiguous.`);
      socket.emit('print_physical_ambiguous', {
        jobId,
        requestId,
        reason: 'Agent crashed during driver dispatch intent window (unconfirmed spooler handoff)',
        wasSeenInQueue: false
      });
    } else if (['COMPLETED_LOCALLY', 'ACKNOWLEDGED'].includes(entry.state)) {
      // Proved completed
      console.log(`📡 Reporting existing completion evidence for Job ${jobId} (state: ${entry.state})`);
      socket.emit('print_physical_success', {
        jobId,
        requestId,
        reconciled: true,
        dispatchedAt: entry.dispatchedAt || entry.dispatchIntentAt,
        completedAt: entry.completedAt
      });
    } else if (['SPOOLER_ACCEPTED', 'DISPATCHED_TO_SPOOLER', 'SPOOLING'].includes(entry.state)) {
      // Spooler accepted before crash, but queue clearance was unverified prior to restart
      console.log(`📡 Job ${jobId} was accepted by spooler prior to crash. Reporting ambiguous.`);
      socket.emit('print_physical_ambiguous', {
        jobId,
        requestId,
        reason: 'Spooler accepted job before agent restart; physical clearance unverified',
        wasSeenInQueue: true
      });
    } else {
      socket.emit('job_reconciliation_report', { requestId, jobId, status: entry.state });
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
    console.warn(`⚠️ IDEMPOTENCY GUARD: Job ${jobData.jobId} was already dispatched/printed locally. Refusing duplicate physical print!`);
    socket.emit('print_physical_success', { jobId: jobData.jobId, alreadyDispatched: true });
    return;
  }

  journal.recordReceived(jobData.jobId, { originalName: jobData.originalName });

  console.log(`\n======================================================`);
  console.log(`📥 NEW PRINT JOB RECEIVED! [Job ID: ${jobData.jobId}]`);
  console.log(`📄 Document: ${jobData.originalName}`);
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
    let printFilePath = localFilePath;

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
        journal.recordDispatchIntent(jobData.jobId, { printerName: PRINTER_NAME, settings: jobData.settings });
        await ptp.print(printFilePath, printOptions);
        journal.recordSpoolerAccepted(jobData.jobId);
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
        journal.recordDispatchIntent(jobData.jobId, { printerName: PRINTER_NAME, settings: jobData.settings });
        await execFileAsync('lp', args);
        journal.recordSpoolerAccepted(jobData.jobId);
      }
      
      console.log(`🖨️  SUCCESS: Job ${jobData.jobId} sent to Print Spooler!`);
      
      // Notify backend that spooler accepted the job
      socket.emit('print_spooler_success', { jobId: jobData.jobId });

      // P3-001: True Print Verification via Spooler Polling
      spoolerMonitor.startPollingJob(jobData.jobId, printFilePath, socket);
    } else {
      // Simulation mode bypass (No physical printer)
      journal.recordDispatchIntent(jobData.jobId, { mode: 'simulation' });
      journal.recordSpoolerAccepted(jobData.jobId, { mode: 'simulation' });
      spoolerMonitor.startPollingJob(jobData.jobId, printFilePath, socket);
    }



  } catch (error) {
    console.error(`❌ ERROR processing Job ${jobData.jobId}:`, error.message);
    socket.emit('print_spooler_error', { jobId: jobData.jobId, error: error.message });
    if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
    if (printFilePath !== localFilePath && fs.existsSync(printFilePath)) fs.unlinkSync(printFilePath);
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
