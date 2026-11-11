const os = require('os');
const fs = require('fs');

const isWin = os.platform() === 'win32';

class SpoolerMonitor {
  constructor({ execFile, printerName, journal }) {
    this.execFile = execFile;
    this.printerName = printerName;
    this.journal = journal;
    this.isCheckingStatus = false;
  }

  checkPrinterStatus(socket) {
    if (!this.printerName || this.printerName === 'SimulationMode') return;
    if (this.isCheckingStatus) return; // Prevent overlapping executions
    this.isCheckingStatus = true;
    
    if (isWin) {
      this.execFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance -ClassName Win32_Printer -Filter "Name='${this.printerName}'" | Select-Object PrinterStatus, ExtendedPrinterStatus, DetectedErrorState, WorkOffline`
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
        } else if (stdout.includes('DetectedErrorState : 5') || stdout.includes('Jam')) {
          isError = true;
          errorMessage = 'Paper Jam';
        }

        this.emitStatus(socket, isError, errorMessage);
      });
    } else {
      // Linux CUPS
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

        this.emitStatus(socket, isError, errorMessage);
      });
    }
  }

  emitStatus(socket, isError, errorMessage) {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memoryUsage = ((totalMem - freeMem) / totalMem * 100).toFixed(2);
    const uptime = os.uptime();

    socket.emit('printer_status_update', {
      isError,
      errorMessage,
      printerName: this.printerName,
      telemetry: {
        memoryUsage: `${memoryUsage}%`,
        uptime: `${uptime}s`,
        platform: os.platform(),
        arch: os.arch()
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

      if (isWin) {
        isPollingExecution = true;
        this.execFile('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-PrintJob -PrinterName '${this.printerName}' -ErrorAction SilentlyContinue | Select-Object Id, DocumentName, JobStatus | ConvertTo-Json`
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
                  `Get-PrintJob -PrinterName '${this.printerName}' | Where-Object DocumentName -like '*${jobId}*' | Remove-PrintJob`
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

module.exports = SpoolerMonitor;
