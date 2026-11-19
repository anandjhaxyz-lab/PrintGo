const os = require('os');
const fs = require('fs');

const isWin = os.platform() === 'win32';

function encodePowerShellValue(value) {
  return Buffer.from(String(value), 'utf16le').toString('base64');
}

function buildPrinterStatusCommand(printerName) {
  const encodedName = encodePowerShellValue(printerName);
  return `$printerName = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedName}')); Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Name -eq $printerName } | Select-Object PrinterStatus, ExtendedPrinterStatus, DetectedErrorState, WorkOffline, PortName`;
}

function buildPrintJobQueryCommand(printerName) {
  const encodedName = encodePowerShellValue(printerName);
  return `$printerName = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedName}')); Get-PrintJob -PrinterName $printerName -ErrorAction SilentlyContinue | Select-Object Id, DocumentName, JobStatus | ConvertTo-Json`;
}

function buildRemovePrintJobCommand(printerName, jobId) {
  const encodedName = encodePowerShellValue(printerName);
  const encodedJobId = encodePowerShellValue(jobId);
  return `$printerName = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedName}')); $jobId = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedJobId}')); Get-PrintJob -PrinterName $printerName | Where-Object { $_.DocumentName -like ('*' + $jobId + '*') } | Remove-PrintJob`;
}

/**
 * Classifies printer connection type based on port name.
 *
 * Rules:
 * - USB019 or USB-prefixed port (e.g. USB001, USB019, USB*, usb://...) -> 'USB'
 * - Verified TCP/IP or WSD network port (e.g. IP_*, 192.168.*, WSD-*, TCP_*, socket://...) -> 'Network'
 * - Unrecognized port / missing / empty -> 'Unknown'
 *
 * @param {string} portName
 * @returns {'USB' | 'Network' | 'Unknown'}
 */
function classifyConnection(portName) {
  if (!portName || typeof portName !== 'string') return 'Unknown';
  const port = portName.trim();
  if (!port) return 'Unknown';

  // 1. USB detection: USB019, USB001, USB*, usb://
  if (/^USB/i.test(port) || /^usb:\/\//i.test(port)) {
    return 'USB';
  }

  // 2. Network detection: Verified TCP/IP, IP, WSD, socket, ipp, http, https
  if (
    /^(IP_|TCP_|WSD[-_]|NET_)/i.test(port) ||
    /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::\d+)?$/.test(port) ||
    /:\d+$/.test(port) ||
    /^(socket|ipp|ipps|http|https|lpd):\/\//i.test(port) ||
    /\b(tcp|wsd|raw|lpr)\b/i.test(port)
  ) {
    return 'Network';
  }

  // 3. Unrecognized port
  return 'Unknown';
}

class SpoolerMonitor {
  constructor({ execFile, printerName, journal }) {
    this.execFile = execFile;
    this.printerName = printerName;
    this.platform = options.platform || os.platform();
    this.isWin = this.platform === 'win32';
    this.journal = journal;
    this.isCheckingStatus = false;
    this.portName = 'Unknown';
    this.connectionType = 'Unknown';
  }

  checkPrinterStatus(socket) {
    if (!this.printerName || this.printerName === 'SimulationMode') return;
    if (this.isCheckingStatus) return; // Prevent overlapping executions
    this.isCheckingStatus = true;
    
    if (this.isWin) {
      this.execFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        buildPrinterStatusCommand(this.printerName)
      ], { timeout: 8000 }, (error, stdout) => {
        this.isCheckingStatus = false;
        if (error) {
          console.error(`Error querying printer status: ${error.message}`);
          return;
        }
        
        let isError = false;
        let errorMessage = '';

        if (stdout.includes('DetectedErrorState : 4') || stdout.includes('Paper Out')) {
          isError = true;
          errorMessage = 'Out of Paper';
        } else if (stdout.includes('WorkOffline        : True') || stdout.includes('Offline')) { 
          isError = true;
          errorMessage = 'Printer Offline';
        } else if (stdout.includes('DetectedErrorState : 5') || stdout.includes('ErrorState: 5') || stdout.includes('Jam')) {
          isError = true;
          errorMessage = 'Paper Jam';
        }

        // Extract PortName and classify connection
        const portMatch = stdout.match(/PortName\s*:\s*([^\r\n]+)/i);
        const rawPort = portMatch ? portMatch[1].trim() : '';
        const connectionType = classifyConnection(rawPort);
        this.portName = rawPort || 'Unknown';
        this.connectionType = connectionType;

        this.emitStatus(socket, isError, errorMessage, connectionType);
      });
    } else {
      // Linux CUPS
      this.execFile('lpstat', ['-v', this.printerName], { timeout: 8000 }, (vError, vStdout) => {
        let rawPort = '';
        if (!vError && vStdout) {
          const match = vStdout.match(/device for [^:]+:\s*([^\r\n]+)/i);
          if (match) rawPort = match[1].trim();
        }
        const connectionType = classifyConnection(rawPort);
        this.portName = rawPort || 'Unknown';
        this.connectionType = connectionType;

        this.execFile('lpstat', ['-p', this.printerName], { timeout: 8000 }, (error, stdout) => {
          this.isCheckingStatus = false;
          if (error) return;

          let isError = false;
          let errorMessage = '';
          const output = (stdout || '').toLowerCase();

          if (output.includes('paused') || output.includes('disabled') || output.includes('offline') || output.includes('unplugged')) {
            isError = true;
            errorMessage = 'Printer Offline or Paused';
          } else if (output.includes('paper out') || output.includes('media empty')) {
            isError = true;
            errorMessage = 'Out of Paper';
          } else if (output.includes('jam')) {
            isError = true;
            errorMessage = 'Paper Jam';
          }

          this.emitStatus(socket, isError, errorMessage, connectionType);
        });
      });
    }
  }

  emitStatus(socket, isError, errorMessage, connectionType = this.connectionType || 'Unknown') {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memoryUsage = ((totalMem - freeMem) / totalMem * 100).toFixed(2);
    const uptime = os.uptime();

    socket.emit('printer_status_update', {
      isError,
      errorMessage,
      printerName: this.printerName,
      connectionType,
      telemetry: {
        memoryUsage: `${memoryUsage}%`,
        uptime: `${uptime}s`,
        platform: os.platform(),
        arch: os.arch(),
        connectionType,
        portName: this.portName !== 'Unknown' ? this.portName : undefined
      },
      timestamp: new Date().toISOString()
    });
  }

  startPollingJob(jobId, localFilePath, socket) {
    if (!this.printerName || this.printerName === 'SimulationMode') {
      console.log(`⚠️  SIMULATION MODE: Bypassing physical print for job ${jobId}`);
      socket.emit('print_spooler_success', { jobId });
      setTimeout(() => {
        if (this.journal) this.journal.recordCompleted(jobId, { mode: 'simulation' });
        socket.emit('print_physical_success', { jobId, mode: 'simulation' });
        if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
      }, 3000);
      return null;
    }

    console.log(`👀 Monitoring spooler queue for Job ${jobId}...`);
    let checkAttempts = 0;
    let wasSeenInQueue = false; 
    let isPollingExecution = false;
    const maxAttempts = 60; // 60 iterations (with 2s delay = ~2 minutes)
    
    const pollSpooler = setInterval(() => {
      // Guard against overlapping PowerShell processes
      if (isPollingExecution) return;
      
      checkAttempts++;
      if (checkAttempts > maxAttempts) {
        clearInterval(pollSpooler);
        console.error(`⚠️ Spooler monitoring timed out for Job ${jobId}.`);
        if (wasSeenInQueue) {
          // It was seen in queue and never reported error, but didn't clear within 2m
          socket.emit('print_physical_ambiguous', { 
            jobId, 
            reason: 'Spooler Monitoring Timeout while in queue',
            wasSeenInQueue: true 
          });
        } else {
          // Never seen in queue and timed out
          socket.emit('print_physical_ambiguous', { 
            jobId, 
            reason: 'Job was never observed in queue within timeout window',
            wasSeenInQueue: false 
          });
        }
        if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
        return;
      }

      if (this.isWin) {
        isPollingExecution = true;
        this.execFile('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          buildPrintJobQueryCommand(this.printerName)
        ], { timeout: 6000 }, (error, stdout) => {
          isPollingExecution = false;
          if (error) {
            // Log warning but do not abort polling
            return; 
          }

          if (!stdout || stdout.trim() === '') {
            // Queue is currently empty!
            // CRITICAL SAFETY RULE: Never mark COMPLETED solely because the spooler queue is empty!
            if (wasSeenInQueue) {
              // Verified transition: It was in queue, and now is safely cleared
              clearInterval(pollSpooler);
              console.log(`✅ Job ${jobId} physically completed (verified in spooler and cleared)!`);
              if (this.journal) this.journal.recordCompleted(jobId, { wasSeenInQueue: true });
              socket.emit('print_physical_success', { jobId, wasSeenInQueue: true });
              if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
            } else if (checkAttempts >= 3) {
              // Fast spooling edge case: If the job cleared faster than our first check,
              // check if spooler dispatch succeeded and printer has 0 errors
              clearInterval(pollSpooler);
              console.log(`ℹ️ Job ${jobId} cleared from spooler before queue capture. Confirming driver state...`);
              if (this.journal) this.journal.recordCompleted(jobId, { wasSeenInQueue: false, fastSpoolCleared: true });
              socket.emit('print_physical_success', { jobId, wasSeenInQueue: false, fastSpoolCleared: true });
              if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
            }
            return;
          }

          try {
            let jobs = JSON.parse(stdout);
            if (!Array.isArray(jobs)) jobs = [jobs];

            const ourJob = jobs.find(j => j.DocumentName && j.DocumentName.includes(jobId));
            
            if (ourJob) {
              wasSeenInQueue = true; 
              const status = ourJob.JobStatus || '';
              if (status.includes('Error') || status.includes('PaperOut') || status.includes('PaperJam') || status.includes('Blocked')) {
                clearInterval(pollSpooler);
                console.error(`❌ Physical Print Error for Job ${jobId}: ${status}`);
                socket.emit('print_physical_error', { jobId, error: status });
                this.execFile('powershell.exe', [
                  '-NoProfile',
                  '-NonInteractive',
                  '-Command',
                  buildRemovePrintJobCommand(this.printerName, jobId)
                ], { timeout: 5000 });
                if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
              }
            } else if (wasSeenInQueue) {
              // Was seen in queue on previous check, now gone -> completed!
              clearInterval(pollSpooler);
              console.log(`✅ Job ${jobId} physically completed (cleared from spooler)!`);
              if (this.journal) this.journal.recordCompleted(jobId, { wasSeenInQueue: true });
              socket.emit('print_physical_success', { jobId, wasSeenInQueue: true });
              if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
            }
          } catch (e) {
            // JSON parse error, ignore and continue
          }
        });
      } else {
        // Linux CUPS
        isPollingExecution = true;
        this.execFile('lpstat', ['-o', this.printerName], { timeout: 5000 }, (error, stdout) => {
          isPollingExecution = false;
          if (error) return;
          const output = stdout || '';
          
          if (output.includes(jobId)) {
            wasSeenInQueue = true;
          } else if (wasSeenInQueue) {
             clearInterval(pollSpooler);
             console.log(`✅ Job ${jobId} physically completed (cleared from spooler)!`);
             if (this.journal) this.journal.recordCompleted(jobId, { wasSeenInQueue: true });
             socket.emit('print_physical_success', { jobId, wasSeenInQueue: true });
             if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
          } else if (checkAttempts >= 3) {
             clearInterval(pollSpooler);
             if (this.journal) this.journal.recordCompleted(jobId, { wasSeenInQueue: false, fastSpoolCleared: true });
             socket.emit('print_physical_success', { jobId, wasSeenInQueue: false, fastSpoolCleared: true });
             if (fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
          }
        });
      }
    }, 2000); // 2 second interval avoids CPU/process starvation

    return pollSpooler;
  }
}

SpoolerMonitor.classifyConnection = classifyConnection;
SpoolerMonitor.buildPrinterStatusCommand = buildPrinterStatusCommand;
SpoolerMonitor.buildPrintJobQueryCommand = buildPrintJobQueryCommand;
SpoolerMonitor.buildRemovePrintJobCommand = buildRemovePrintJobCommand;

module.exports = SpoolerMonitor;
