const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const { EventEmitter } = require('events');

const MUTEX_NAME = 'Global\\NEOX_UniversalPrintAgent_Running';

const SHUTDOWN_STATE = {
  IDLE: 'IDLE',
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED'
};

function isProcessRunning(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function getProcessInfo(pid) {
  if (!pid || typeof pid !== 'number') return null;
  if (process.platform !== 'win32') {
    if (!isProcessRunning(pid)) return null;
    return { ProcessId: pid, Name: 'node', CommandLine: '' };
  }
  try {
    const cmd = `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress`;
    const out = execSync(`powershell.exe -NoProfile -Command "${cmd}"`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).toString('utf8').trim();
    if (!out) return null;
    return JSON.parse(out);
  } catch (_) {
    return null;
  }
}

function getMutexDir(mutexName) {
  const sanitized = mutexName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = path.join(os.tmpdir(), `printgo_mutex_${sanitized}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function buildPowerShellScript(mutexName, statusFile = '', attemptFile = '', releaseFile = '', parentPid = process.pid, acquisitionToken = '') {
  return `
$mutexName = '${mutexName}'
$statusFile = '${statusFile.replace(/\\/g, '\\\\')}'
$attemptFile = '${attemptFile.replace(/\\/g, '\\\\')}'
$releaseFile = '${releaseFile.replace(/\\/g, '\\\\')}'
$parentPid = ${parentPid || $PID}
$acquisitionToken = '${acquisitionToken}'

try {
    $createdNew = $false
    $mutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$createdNew)
    if (-not $createdNew) {
        try {
            $hasHandle = $mutex.WaitOne(0, $false)
            if (-not $hasHandle) {
                if ($attemptFile -ne '') {
                    $data = @{ status = 'MUTEX_ALREADY_HELD'; helperPid = $PID; parentPid = $parentPid; acquisitionToken = $acquisitionToken } | ConvertTo-Json -Compress
                    [System.IO.File]::WriteAllText($attemptFile, $data)
                }
                [Console]::Error.WriteLine("MUTEX_ALREADY_HELD")
                exit 1
            }
        } catch [System.Threading.AbandonedMutexException] {
            # Previous owning process crashed/abandoned the mutex. Ownership safely claimed.
        }
    }

    $procObj = [System.Diagnostics.Process]::GetCurrentProcess()
    $helperStartTime = $procObj.StartTime.ToString('o')
    $helperCreationFileTime = $procObj.StartTime.ToFileTimeUtc()
    if ($statusFile -ne '') {
        $data = @{ status = 'ACQUIRED'; helperPid = $PID; parentPid = $parentPid; acquisitionToken = $acquisitionToken; mutexName = $mutexName; helperStartTime = $helperStartTime; helperCreationFileTime = $helperCreationFileTime; createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
        $tmpStatus = "$statusFile.tmp"
        [System.IO.File]::WriteAllText($tmpStatus, $data)
        if ([System.IO.File]::Exists($statusFile)) {
            try { [System.IO.File]::Delete($statusFile) } catch {}
        }
        [System.IO.File]::Move($tmpStatus, $statusFile)
    }
    if ($attemptFile -ne '') {
        $data = @{ status = 'ACQUIRED'; helperPid = $PID; parentPid = $parentPid; acquisitionToken = $acquisitionToken; helperStartTime = $helperStartTime; helperCreationFileTime = $helperCreationFileTime } | ConvertTo-Json -Compress
        $tmpAttempt = "$attemptFile.tmp"
        [System.IO.File]::WriteAllText($tmpAttempt, $data)
        if ([System.IO.File]::Exists($attemptFile)) {
            try { [System.IO.File]::Delete($attemptFile) } catch {}
        }
        [System.IO.File]::Move($tmpAttempt, $attemptFile)
    }
    [Console]::Out.WriteLine("MUTEX_ACQUIRED")
    [Console]::Out.Flush()
} catch {
    if ($attemptFile -ne '') {
        $data = @{ status = 'ERROR'; message = $_.Exception.Message } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($attemptFile, $data)
    }
    [Console]::Error.WriteLine("MUTEX_ERROR: " + $_.Exception.Message)
    exit 2
}

# UP-05 FAIL-CLOSED LOOP:
# The helper process holds the Windows Named Mutex continuously in memory.
# It releases the kernel mutex ONLY when explicit release instruction matching its acquisition token is received.
while ($true) {
    if ($releaseFile -ne '' -and [System.IO.File]::Exists($releaseFile)) {
        try {
            $tokenInFile = [System.IO.File]::ReadAllText($releaseFile).Trim()
            if ($tokenInFile -eq $acquisitionToken) {
                $mutex.ReleaseMutex()
                $mutex.Dispose()
                try { [System.IO.File]::Delete($releaseFile) } catch {}
                try {
                    if ([System.IO.File]::Exists($statusFile)) {
                        $sRaw = [System.IO.File]::ReadAllText($statusFile)
                        if ($sRaw -match $acquisitionToken) {
                            [System.IO.File]::Delete($statusFile)
                        }
                    }
                } catch {}
                exit 0
            }
        } catch {}
    }
    [System.Threading.Thread]::Sleep(150)
}
`;
}

function createMutexHandle({
  mutexName,
  platform,
  pid,
  processHelper,
  isSimulated = false,
  options = {},
  cleanupFn = () => {},
  acquisitionToken = null,
  releaseFile = null
}) {
  let released = false;
  let isShuttingDown = false;
  let shutdownState = SHUTDOWN_STATE.IDLE;
  let shutdownPromise = null;
  const shutdownHandlers = [];
  if (typeof options.onShutdown === 'function') {
    shutdownHandlers.push(options.onShutdown);
  }

  const defaultExitOnShutdown = process.env.JEST_WORKER_ID === undefined && process.env.NODE_ENV !== 'test';
  const shouldExitOnShutdown = options.exitOnShutdown !== undefined
    ? Boolean(options.exitOnShutdown)
    : defaultExitOnShutdown;

  let detachSignalHandlers = () => {};

  const rawRelease = () => {
    if (!released) {
      released = true;
      detachSignalHandlers();
      cleanupFn();
      if (processHelper) {
        try { processHelper.kill('SIGTERM'); } catch (_) {}
      }
    }
  };

  const handle = {
    acquired: true,
    mutexName,
    platform,
    pid: pid || (processHelper ? processHelper.pid : process.pid),
    process: processHelper,
    isSimulated,
    acquisitionToken,
    releaseFile,
    get released() { return released; },
    set released(v) { released = Boolean(v); },
    get isShuttingDown() { return isShuttingDown; },
    get shutdownState() { return shutdownState; },
    shutdownHandlers,
    registerShutdown: (fn) => {
      if (typeof fn === 'function' && !shutdownHandlers.includes(fn)) {
        shutdownHandlers.push(fn);
      }
    },
    isOperational: () => {
      if (typeof options.isOperational === 'function') {
        return Boolean(options.isOperational());
      }
      if (typeof options.isOperational === 'boolean') {
        return options.isOperational;
      }
      return false;
    },
    release: (force = false) => {
      if (!force && handle.isOperational()) {
        throw new Error('Illegal state: Mutex ownership cannot be released while an operational Agent continues running. Invoke graceful shutdown lifecycle first.');
      }
      shutdownState = SHUTDOWN_STATE.SUCCESS;
      rawRelease();
    },
    _rawRelease: rawRelease,
    shutdown: async (signal = 'SIGINT', exitCode = 0) => {
      if (shutdownPromise) return shutdownPromise;
      isShuttingDown = true;
      shutdownState = SHUTDOWN_STATE.IN_PROGRESS;

      shutdownPromise = (async () => {
        let handlerError = null;
        for (const handler of shutdownHandlers) {
          try {
            await handler(signal);
          } catch (err) {
            handlerError = err;
            console.error(`Error in shutdown handler for signal ${signal}:`, err);
            break;
          }
        }

        // UP-05 FAIL-CLOSED: Mutex MUST NOT be released if any shutdown handler failed
        if (handlerError) {
          shutdownState = SHUTDOWN_STATE.FAILED;
          throw new Error(`Agent shutdown failed during ${signal}: ${handlerError.message}`);
        }

        // UP-05 FAIL-CLOSED: Mutex MUST NOT be released if background work is still operational
        if (handle.isOperational()) {
          shutdownState = SHUTDOWN_STATE.FAILED;
          throw new Error(`Illegal state: Mutex ownership cannot be released because background work remains operational after ${signal} shutdown.`);
        }

        // Graceful teardown complete: mark SUCCESS and release mutex cleanly
        shutdownState = SHUTDOWN_STATE.SUCCESS;
        rawRelease();

        if (shouldExitOnShutdown && !options.suppressFatalOnExit) {
          process.exit(exitCode);
        }
      })();
      return shutdownPromise;
    }
  };

  // Signal & exit listeners
  const onSignal = async (signal) => {
    try {
      await handle.shutdown(signal, 0);
    } catch (err) {
      console.error(`Error during Agent ${signal} shutdown:`, err);
      if (shouldExitOnShutdown && !options.suppressFatalOnExit) {
        process.exit(1);
      }
    }
  };

  const onExit = () => {
    // UP-05 FAIL-CLOSED: Mutex release is ONLY permitted upon verified successful shutdown!
    if (shutdownState === SHUTDOWN_STATE.SUCCESS) {
      rawRelease();
    } else {
      console.error(`🛑 [UP-05 FAIL-CLOSED] Mutex release bypassed on process exit (shutdownState='${shutdownState}', operational=${handle.isOperational()}). Kernel mutex remains locked fail-closed.`);
    }
  };

  process.once('exit', onExit);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  detachSignalHandlers = () => {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
  handle.detachSignalHandlers = detachSignalHandlers;

  return handle;
}

/**
 * UP-05: Acquires and holds the exact Windows Named Mutex:
 * Global\NEOX_UniversalPrintAgent_Running
 * 
 * Guarantees a single active Agent process per machine across all user sessions.
 * Holds kernel mutex ownership for the entire process lifetime.
 * Releases cleanly on verified shutdown, or retains kernel lock fail-closed on shutdown failure.
 */
function acquireAgentMutex(options = {}) {
  return new Promise((resolve, reject) => {
    const platform = options.platform || process.platform;
    const mutexName = options.mutexName || MUTEX_NAME;

    if (platform !== 'win32' && !options.force) {
      // In non-Windows test environments, return mock ownership
      return resolve(createMutexHandle({
        mutexName,
        platform,
        isSimulated: true,
        options
      }));
    }

    const acquisitionToken = crypto.randomUUID();
    const dir = getMutexDir(mutexName);
    const statusFile = path.join(dir, 'status.json');
    const releaseFile = path.join(dir, `release_${acquisitionToken}.signal`);
    const attemptFile = path.join(dir, `attempt_${acquisitionToken}.json`);
    const scriptFile = path.join(dir, `holder_${acquisitionToken}.ps1`);

    if (fs.existsSync(attemptFile)) {
      try { fs.unlinkSync(attemptFile); } catch (_) {}
    }

    const parentPid = process.pid;
    const script = options.script || buildPowerShellScript(mutexName, statusFile, attemptFile, releaseFile, parentPid, acquisitionToken);
    fs.writeFileSync(scriptFile, script, 'utf8');

    // Launch independent detached process holding the kernel mutex
    const launchCmd = `powershell.exe -NoProfile -Command "Start-Process powershell.exe -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '${scriptFile.replace(/\\/g, '\\\\')}' -WindowStyle Hidden"`;
    try {
      execSync(launchCmd);
    } catch (launchErr) {
      try { if (fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile); } catch (_) {}
      return reject(new Error(`Failed to launch Windows named mutex helper: ${launchErr.message}`));
    }

    // Wait for helper process to report status in attemptFile
    const start = Date.now();
    let statusData = null;
    const pollInterval = 50;
    const timeoutMs = options.acquisitionTimeoutMs || 12000;

    const timer = setInterval(() => {
      if (fs.existsSync(attemptFile)) {
        try {
          const raw = fs.readFileSync(attemptFile, 'utf8').trim();
          if (raw) {
            statusData = JSON.parse(raw);
            try { fs.unlinkSync(attemptFile); } catch (_) {}
            clearInterval(timer);
            return onHandshakeComplete();
          }
        } catch (_) {}
      }

      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        try { if (fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile); } catch (_) {}
        return reject(new Error(`Timed out waiting for Windows named mutex helper to acquire '${mutexName}'.`));
      }
    }, pollInterval);

    function onHandshakeComplete() {
      if (!statusData) {
        try { if (fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile); } catch (_) {}
        return reject(new Error(`Failed to read mutex status for '${mutexName}'.`));
      }

      if (statusData.status === 'MUTEX_ALREADY_HELD') {
        try { if (fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile); } catch (_) {}
        const err = new Error(`Another PrintGo / NEOX Agent instance is already running on this machine (Mutex ${mutexName} is held).`);
        err.code = 'MUTEX_ALREADY_HELD';
        err.mutexName = mutexName;
        return reject(err);
      }

      if (statusData.status !== 'ACQUIRED') {
        try { if (fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile); } catch (_) {}
        const err = new Error(`Mutex acquisition helper failed: ${statusData.message || statusData.status}`);
        err.code = 'MUTEX_HELPER_FAILED';
        err.mutexName = mutexName;
        return reject(err);
      }

      const helperPid = statusData.helperPid;
      const helperEmitter = new EventEmitter();
      helperEmitter.pid = helperPid;
      helperEmitter.kill = (signal = 'SIGTERM') => {
        try {
          process.kill(helperPid, signal);
        } catch (_) {
          try { execSync(`taskkill /F /PID ${helperPid}`, { stdio: 'ignore' }); } catch (_) {}
        }
      };

      // Watch helper process liveness
      let monitorExited = false;
      const livenessInterval = setInterval(() => {
        if (!isProcessRunning(helperPid)) {
          clearInterval(livenessInterval);
          if (!monitorExited) {
            monitorExited = true;
            helperEmitter.emit('exit', 0, null);
          }
        }
      }, 100);

      const cleanupFn = () => {
        clearInterval(livenessInterval);
        try { fs.writeFileSync(releaseFile, acquisitionToken, 'utf8'); } catch (_) {}
        const rStart = Date.now();
        while (Date.now() - rStart < 1500) {
          if (!isProcessRunning(helperPid)) break;
          try { execSync('powershell.exe -NoProfile -Command "Start-Sleep -Milliseconds 50"', { stdio: 'ignore' }); } catch (_) {}
        }
        try { execSync(`taskkill /F /PID ${helperPid}`, { stdio: 'ignore' }); } catch (_) {}
        try { if (fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile); } catch (_) {}
        try { if (fs.existsSync(attemptFile)) fs.unlinkSync(attemptFile); } catch (_) {}
        try { if (fs.existsSync(releaseFile)) fs.unlinkSync(releaseFile); } catch (_) {}
        try {
          if (fs.existsSync(statusFile)) {
            const cur = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
            if (cur.acquisitionToken === acquisitionToken) {
              fs.unlinkSync(statusFile);
            }
          }
        } catch (_) {}
      };

      const handle = createMutexHandle({
        mutexName,
        platform: 'win32',
        pid: helperPid,
        processHelper: helperEmitter,
        isSimulated: false,
        options,
        cleanupFn,
        acquisitionToken,
        releaseFile
      });

      // Fail-closed rule: if helper terminates unexpectedly while not released, Agent must shut down
      const defaultExitOnShutdown = process.env.JEST_WORKER_ID === undefined && process.env.NODE_ENV !== 'test';
      const shouldExitOnShutdown = options.exitOnShutdown !== undefined
        ? Boolean(options.exitOnShutdown)
        : defaultExitOnShutdown;

      helperEmitter.on('exit', async (code, signal) => {
        if (!handle.released && !options.suppressFatalOnExit && shouldExitOnShutdown) {
          console.error(`🔥 CRITICAL ERROR: [UP-05] Windows named mutex helper process terminated unexpectedly (code: ${code}, signal: ${signal}). Failing closed.`);
          try {
            await handle.shutdown('MUTEX_HELPER_EXIT', 1);
          } catch (_) {}
          process.exit(1);
        }
      });

      return resolve(handle);
    }
  });
}

/**
 * Controlled Operator Recovery:
 * Terminates an orphaned mutex helper process IF AND ONLY IF helper ownership and dead parent can be conclusively verified.
 * Fails closed if ownership cannot be positively established.
 * Requires an authorized operator reason with at least 10 non-whitespace characters.
 * Rejects if the parent Agent process is still alive and operational.
 * Defends against PID reuse for both helper and parent.
 * Never executes broad process sweeps.
 */
function recoverOrphanedMutex({ mutexName = MUTEX_NAME, operatorReason } = {}) {
  if (!operatorReason || typeof operatorReason !== 'string') {
    const err = new Error('MUTEX_RECOVERY_REASON_REQUIRED: Operator reason containing at least 10 non-whitespace characters is required.');
    err.code = 'MUTEX_RECOVERY_REASON_REQUIRED';
    throw err;
  }
  const clean = operatorReason.trim().replace(/\s/g, '');
  if (clean.length < 10) {
    const err = new Error(`MUTEX_RECOVERY_REASON_REQUIRED: Operator reason containing at least 10 non-whitespace characters is required (received ${clean.length}).`);
    err.code = 'MUTEX_RECOVERY_REASON_REQUIRED';
    throw err;
  }

  const dir = getMutexDir(mutexName);
  const statusFile = path.join(dir, 'status.json');

  if (!fs.existsSync(statusFile)) {
    const err = new Error(`MUTEX_OWNERSHIP_UNVERIFIED: State file status.json for mutex '${mutexName}' is missing. Cannot verify helper ownership. Recovery refused.`);
    err.code = 'MUTEX_OWNERSHIP_UNVERIFIED';
    throw err;
  }

  let statusData = null;
  try {
    statusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch (parseErr) {
    const err = new Error(`MUTEX_OWNERSHIP_UNVERIFIED: State file status.json for mutex '${mutexName}' is corrupted (${parseErr.message}). Cannot verify helper ownership. Recovery refused.`);
    err.code = 'MUTEX_OWNERSHIP_UNVERIFIED';
    throw err;
  }

  if (
    !statusData ||
    statusData.status !== 'ACQUIRED' ||
    !statusData.helperPid ||
    !statusData.parentPid ||
    !statusData.acquisitionToken
  ) {
    const err = new Error(`MUTEX_OWNERSHIP_UNVERIFIED: State file status.json for mutex '${mutexName}' is incomplete or missing required ownership fields. Recovery refused.`);
    err.code = 'MUTEX_OWNERSHIP_UNVERIFIED';
    throw err;
  }

  // 1. Verify Parent Agent Process (Healthy Agent Protection & PID reuse check)
  const parentPid = statusData.parentPid;
  if (isProcessRunning(parentPid)) {
    const parentInfo = getProcessInfo(parentPid);
    const isNodeAgent = parentInfo && parentInfo.Name && (
      parentInfo.Name.toLowerCase().includes('node') ||
      (parentInfo.CommandLine && (parentInfo.CommandLine.toLowerCase().includes('agent') || parentInfo.CommandLine.toLowerCase().includes('jest')))
    );
    if (isNodeAgent || !parentInfo) {
      const err = new Error(`AGENT_PROCESS_ALIVE: Cannot recover mutex: Parent Agent process (PID ${parentPid}) is actively running and healthy.`);
      err.code = 'AGENT_PROCESS_ALIVE';
      throw err;
    }
    // Parent info exists but is NOT node/agent (e.g. PID was reused by another OS process like notepad.exe)
  }

  // 2. Verify Helper Process Identity & Ownership and atomically terminate via native Win32 handle (PID reuse & TOCTOU prevention)
  const helperPid = statusData.helperPid;
  const token = statusData.acquisitionToken;

  // F1 FIX: helperCreationFileTime must be a positive integer; if absent, zero, or invalid,
  // expectedCreationFileTime defaults to 0 and the C# kernel verification strictly returns 13
  // (PID reuse / unverifiable identity) instead of skipping the guard.
  const rawFileTime = statusData.helperCreationFileTime;
  const expectedCreationFileTime = (typeof rawFileTime === 'number' && rawFileTime > 0) ? rawFileTime : 0;

  if (process.platform === 'win32') {
    const recoveryPsScript = `
$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Win32ProcessTerminator {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint processAccess, bool bInheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessTimes(
        IntPtr hProcess,
        out long lpCreationTime,
        out long lpExitTime,
        out long lpKernelTime,
        out long lpUserTime);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool QueryFullProcessImageName(
        IntPtr hProcess,
        uint dwFlags,
        StringBuilder lpExeName,
        ref uint lpdwSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    public const uint PROCESS_TERMINATE = 0x0001;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const uint SYNCHRONIZE = 0x00100000;

    public static int TerminateVerified(int targetPid, long expectedCreationFileTime) {
        uint access = PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
        IntPtr hProcess = OpenProcess(access, false, targetPid);
        if (hProcess == IntPtr.Zero) return 10;

        try {
            long creationTime, exitTime, kernelTime, userTime;
            if (!GetProcessTimes(hProcess, out creationTime, out exitTime, out kernelTime, out userTime)) return 10;

            // F1 FIX: expectedCreationFileTime is strictly required. If absent, zero, or non-positive,
            // return 13 (PID_REUSE_DETECTED) rather than skipping the creation time guard.
            if (expectedCreationFileTime <= 0) return 13;

            long diff = Math.Abs(creationTime - expectedCreationFileTime);
            if (diff > 1000000L) return 13; // >100ms diff indicates PID reuse

            uint size = 1024;
            StringBuilder sb = new StringBuilder((int)size);
            bool imgResult = QueryFullProcessImageName(hProcess, 0, sb, ref size);
            // F3 FIX: treat QueryFullProcessImageName failure as identity-unverifiable → refuse
            if (!imgResult) return 11;
            {
                string lower = sb.ToString().ToLower();
                if (!lower.EndsWith("powershell.exe") && !lower.EndsWith("pwsh.exe")) return 11;
            }

            if (!TerminateProcess(hProcess, 1)) return 14;
            // F4 FIX: capture and check WaitForSingleObject return value
            uint waitResult = WaitForSingleObject(hProcess, 5000);
            if (waitResult != 0) return 15; // WAIT_TIMEOUT(0x102) or WAIT_FAILED(0xFFFFFFFF)
            return 0;
        } finally {
            CloseHandle(hProcess);
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $source
} catch {}

$targetPid = ${helperPid}
$expectedToken = '${token}'
$expectedFileTime = [long]${expectedCreationFileTime}

# Step 1: Verify Ownership Evidence from CIM
$cim = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $targetPid)
if (-not $cim) { exit 10 }
$cmd = if ($cim.CommandLine) { $cim.CommandLine } else { '' }
$tokenMatch = $cmd.Contains($expectedToken)
$scriptMatch = $cmd.Contains("holder_" + $expectedToken + ".ps1")
$mutexMatch = $cmd.Contains('${mutexName.replace(/\\/g, '\\\\')}')

# F5 FIX: $mutexMatch alone is insufficient — the mutex name can appear in any PowerShell
# command. Require tokenMatch OR scriptMatch (direct acquisition evidence) to pass identity.
if (-not $tokenMatch -and -not $scriptMatch) {
    exit 12
}

# Step 2: Native OpenProcess -> GetProcessTimes -> Verify -> TerminateProcess using the EXACT SAME HANDLE
$res = [Win32ProcessTerminator]::TerminateVerified($targetPid, $expectedFileTime)
exit $res
`;
    const recScriptFile = path.join(dir, `recovery_${token}.ps1`);
    fs.writeFileSync(recScriptFile, recoveryPsScript, 'utf8');

    try {
      execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${recScriptFile}"`, {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10000
      });
    } catch (err) {
      const code = err.status;
      if (code === 10) {
        try { fs.unlinkSync(statusFile); } catch (_) {}
        const e = new Error(`HELPER_NOT_RUNNING: Mutex helper process (PID ${helperPid}) is not running.`);
        e.code = 'HELPER_NOT_RUNNING';
        throw e;
      }
      if (code === 11 || code === 12 || code === 13) {
        const e = new Error(`PID_REUSE_DETECTED: Process with PID ${helperPid} does not match verified helper identity (code ${code}). Recovery refused to protect unrelated process.`);
        e.code = 'PID_REUSE_DETECTED';
        throw e;
      }
      // F4 FIX: code 15 means WaitForSingleObject timed out or failed after TerminateProcess —
      // process may or may not have exited; refuse recovery to avoid ambiguity.
      if (code === 15) {
        const e = new Error(`TERMINATION_WAIT_FAILED: TerminateProcess was called on PID ${helperPid} but WaitForSingleObject did not confirm exit within 5000ms. Recovery state is ambiguous.`);
        e.code = 'TERMINATION_WAIT_FAILED';
        throw e;
      }
      const e = new Error(`MUTEX_OWNERSHIP_UNVERIFIED: Atomic termination of helper PID ${helperPid} failed (exit code ${code}). Recovery refused.`);
      e.code = 'MUTEX_OWNERSHIP_UNVERIFIED';
      throw e;
    } finally {
      try { if (fs.existsSync(recScriptFile)) fs.unlinkSync(recScriptFile); } catch (_) {}
    }

    // Allow Windows OS handle table to reclaim kernel mutex
    try {
      execSync('powershell.exe -NoProfile -Command "Start-Sleep -Milliseconds 200"', { stdio: 'ignore' });
    } catch (_) {}
  } else {
    if (!isProcessRunning(helperPid)) {
      try { fs.unlinkSync(statusFile); } catch (_) {}
      const err = new Error(`HELPER_NOT_RUNNING: Mutex helper process (PID ${helperPid}) is not running.`);
      err.code = 'HELPER_NOT_RUNNING';
      throw err;
    }
    try { process.kill(helperPid, 'SIGKILL'); } catch (_) {}
  }

  // Clean up state file and acquisition files
  try { if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile); } catch (_) {}
  const releaseFile = path.join(dir, `release_${statusData.acquisitionToken}.signal`);
  try { if (fs.existsSync(releaseFile)) fs.unlinkSync(releaseFile); } catch (_) {}
  const scriptFile = path.join(dir, `holder_${statusData.acquisitionToken}.ps1`);
  try { if (fs.existsSync(scriptFile)) fs.unlinkSync(scriptFile); } catch (_) {}

  return {
    recovered: true,
    mutexName,
    acquisitionToken: statusData.acquisitionToken,
    terminatedHelperPid: helperPid,
    operatorReason: operatorReason.trim()
  };
}

module.exports = {
  MUTEX_NAME,
  SHUTDOWN_STATE,
  acquireAgentMutex,
  buildPowerShellScript,
  recoverOrphanedMutex,
  isProcessRunning,
  getProcessInfo,
  getMutexDir
};
