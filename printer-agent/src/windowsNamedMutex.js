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

function createMutexHandle({
  mutexName,
  platform,
  pid,
  processHelper,
  isSimulated = false,
  options = {}
}) {
  let released = false;
  let isShuttingDown = false;
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
      if (processHelper) {
        try { processHelper.stdin.end(); } catch (_) {}
        try { processHelper.kill(); } catch (_) {}
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
    get released() { return released; },
    set released(v) { released = Boolean(v); },
    get isShuttingDown() { return isShuttingDown; },
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
      rawRelease();
    },
    _rawRelease: rawRelease,
    shutdown: async (signal = 'SIGINT', exitCode = 0) => {
      if (shutdownPromise) return shutdownPromise;
      isShuttingDown = true;
      shutdownPromise = (async () => {
        for (const handler of shutdownHandlers) {
          try {
            await handler(signal);
          } catch (err) {
            console.error(`Error in shutdown handler for signal ${signal}:`, err);
          }
        }
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
    rawRelease();
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
 * Releases cleanly on exit, or Windows kernel cleans it up on unexpected termination.
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
        handle = createMutexHandle({
          mutexName,
          platform: 'win32',
          pid: helper.pid,
          processHelper: helper,
          isSimulated: false,
          options
        });

        // Fail-closed rule: if the mutex helper process dies unexpectedly, the Agent must shut down
        helper.on('exit', async (code, signal) => {
          if (!handle.released && !options.suppressFatalOnExit) {
            console.error(`🔥 CRITICAL ERROR: [UP-05] Windows named mutex helper process terminated unexpectedly (code: ${code}, signal: ${signal}). Failing closed.`);
            try {
              await handle.shutdown('MUTEX_HELPER_EXIT', 1);
            } catch (_) {}
            process.exit(1);
          }
        });

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
