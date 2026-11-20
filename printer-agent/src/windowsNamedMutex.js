const { spawn } = require('child_process');

const MUTEX_NAME = 'Global\\NEOX_UniversalPrintAgent_Running';

function buildPowerShellScript(mutexName) {
  return `
$mutexName = '${mutexName}'
try {
    $createdNew = $false
    $mutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$createdNew)
    if (-not $createdNew) {
        try {
            $hasHandle = $mutex.WaitOne(0, $false)
            if (-not $hasHandle) {
                [Console]::Error.WriteLine("MUTEX_ALREADY_HELD")
                exit 1
            }
        } catch [System.Threading.AbandonedMutexException] {
            # Previous owning process crashed/abandoned the mutex. Ownership safely claimed.
        }
    }
    [Console]::Out.WriteLine("MUTEX_ACQUIRED")
    [Console]::Out.Flush()
    
    # Block and hold the kernel mutex for the lifetime of the Agent process
    $line = [Console]::In.ReadLine()
    try {
        $mutex.ReleaseMutex()
        $mutex.Dispose()
    } catch {}
    exit 0
} catch {
    [Console]::Error.WriteLine("MUTEX_ERROR: " + $_.Exception.Message)
    exit 2
}
`;
}

/**
 * UP-05: Acquires and holds the exact Windows Named Mutex:
 * Global\\NEOX_UniversalPrintAgent_Running
 * 
 * Guarantees a single active Agent process per machine across all user sessions.
 * Holds kernel mutex ownership for the entire process lifetime.
 * Releases cleanly on exit, or Windows kernel cleans it up on unexpected termination.
 */
function acquireAgentMutex(options = {}) {
  return new Promise((resolve, reject) => {
    const platform = options.platform || process.platform;
    const mutexName = options.mutexName || MUTEX_NAME;

    if (platform !== 'win32' && !options.force) {
      // In non-Windows test environments, return mock ownership
      return resolve({
        acquired: true,
        mutexName,
        platform,
        isSimulated: true,
        release: () => {}
      });
    }

    const script = options.script || buildPowerShellScript(mutexName);
    const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    let acquired = false;
    let stderrOutput = '';
    let handle = null;

    helper.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('MUTEX_ACQUIRED') && !acquired) {
        acquired = true;
        handle = {
          acquired: true,
          mutexName,
          platform: 'win32',
          pid: helper.pid,
          process: helper,
          released: false,
          release: () => {
            if (handle && !handle.released) {
              handle.released = true;
              try { helper.stdin.end(); } catch (_) {}
              try { helper.kill(); } catch (_) {}
            }
          }
        };

        // Fail-closed rule: if the mutex helper process dies unexpectedly, the Agent must shut down
        helper.on('exit', (code, signal) => {
          if (!handle.released && !options.suppressFatalOnExit) {
            console.error(`🔥 CRITICAL ERROR: [UP-05] Windows named mutex helper process terminated unexpectedly (code: ${code}, signal: ${signal}). Failing closed.`);
            process.exit(1);
          }
        });

        // Register process cleanup handlers
        const cleanup = () => {
          if (handle && !handle.released) {
            handle.release();
          }
        };
        process.once('exit', cleanup);
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);

        resolve(handle);
      }
    });

    helper.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString();
    });

    helper.on('error', (err) => {
      reject(new Error(`Failed to spawn Windows named mutex helper: ${err.message}`));
    });

    helper.on('exit', (code) => {
      if (!acquired) {
        if (stderrOutput.includes('MUTEX_ALREADY_HELD') || code === 1) {
          const err = new Error(`Another PrintGo / NEOX Agent instance is already running on this machine (Mutex ${mutexName} is held).`);
          err.code = 'MUTEX_ALREADY_HELD';
          err.mutexName = mutexName;
          reject(err);
        } else {
          const err = new Error(`Mutex acquisition helper failed with code ${code}: ${stderrOutput.trim()}`);
          err.code = 'MUTEX_HELPER_FAILED';
          err.mutexName = mutexName;
          reject(err);
        }
      }
    });
  });
}

module.exports = {
  MUTEX_NAME,
  acquireAgentMutex,
  buildPowerShellScript
};
