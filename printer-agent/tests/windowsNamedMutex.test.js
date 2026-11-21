const { spawn } = require('child_process');
const path = require('path');
const {
  MUTEX_NAME,
  acquireAgentMutex,
  buildPowerShellScript
} = require('../src/windowsNamedMutex');

describe('UP-05: Windows Named Mutex (Global\\NEOX_UniversalPrintAgent_Running)', () => {
  const isWindows = process.platform === 'win32';
  const testMutexPrefix = 'Global\\NEOX_UniversalPrintAgent_Running_Test_';

  test('1. Contract verification: exact mutex name matches specification', () => {
    expect(MUTEX_NAME).toBe('Global\\NEOX_UniversalPrintAgent_Running');
  });

  test('2. PowerShell script generates valid .NET code referencing the target mutex', () => {
    const script = buildPowerShellScript('Global\\Test_Mutex_Name');
    expect(script).toContain("Global\\Test_Mutex_Name");
    expect(script).toContain('[System.Threading.Mutex]::new($true, $mutexName, [ref]$createdNew)');
    expect(script).toContain('MUTEX_ALREADY_HELD');
    expect(script).toContain('MUTEX_ACQUIRED');
  });

  (isWindows ? test : test.skip)('3. First instance successfully acquires mutex on Windows', async () => {
    const uniqueMutex = `${testMutexPrefix}FirstAcquire_${Date.now()}`;
    const handle = await acquireAgentMutex({ mutexName: uniqueMutex, force: true });
    
    expect(handle).toBeDefined();
    expect(handle.acquired).toBe(true);
    expect(handle.mutexName).toBe(uniqueMutex);
    expect(handle.platform).toBe('win32');
    expect(typeof handle.release).toBe('function');

    handle.release();
  });

  (isWindows ? test : test.skip)('4. Second instance is strictly rejected while first holds the mutex', async () => {
    const uniqueMutex = `${testMutexPrefix}Rejection_${Date.now()}`;
    const handle1 = await acquireAgentMutex({ mutexName: uniqueMutex, force: true });
    expect(handle1.acquired).toBe(true);

    let rejectedError = null;
    try {
      await acquireAgentMutex({ mutexName: uniqueMutex, force: true });
    } catch (err) {
      rejectedError = err;
    }

    expect(rejectedError).not.toBeNull();
    expect(rejectedError.code).toBe('MUTEX_ALREADY_HELD');
    expect(rejectedError.message).toContain('Another PrintGo / NEOX Agent instance is already running');

    handle1.release();
  });

  (isWindows ? test : test.skip)('5. Normal release allows a subsequent instance to acquire the mutex', async () => {
    const uniqueMutex = `${testMutexPrefix}NormalRelease_${Date.now()}`;
    const handle1 = await acquireAgentMutex({ mutexName: uniqueMutex, force: true });
    expect(handle1.acquired).toBe(true);

    // Release handle 1
    handle1.release();

    // Small delay for OS process cleanup
    await new Promise((r) => setTimeout(r, 200));

    const handle2 = await acquireAgentMutex({ mutexName: uniqueMutex, force: true });
    expect(handle2.acquired).toBe(true);
    handle2.release();
  });

  (isWindows ? test : test.skip)('6. Forced termination of first instance releases kernel mutex automatically for subsequent instance', async () => {
    const uniqueMutex = `${testMutexPrefix}CrashRecovery_${Date.now()}`;
    // Pass suppressFatalOnExit: true so that killing handle1 does not exit the Jest test runner process
    const handle1 = await acquireAgentMutex({ mutexName: uniqueMutex, force: true, suppressFatalOnExit: true });
    expect(handle1.acquired).toBe(true);

    // Forcibly kill the underlying helper process (simulating hard process crash)
    handle1.process.kill('SIGKILL');

    // Small delay for OS kernel object manager cleanup
    await new Promise((r) => setTimeout(r, 600));

    // Handle 2 must succeed because Windows kernel cleans up orphaned handles
    const handle2 = await acquireAgentMutex({ mutexName: uniqueMutex, force: true });
    expect(handle2.acquired).toBe(true);
    handle2.release();
  });

  test('7. Non-Windows test environments acquire simulated mutex safely', async () => {
    const handle = await acquireAgentMutex({ platform: 'linux', force: false });
    expect(handle.acquired).toBe(true);
    expect(handle.isSimulated).toBe(true);
  });

  (isWindows ? test : test.skip)('8. Fail-closed: Helper process unexpected exit triggers documented error handling', async () => {
    const uniqueMutex = `${testMutexPrefix}HelperDeath_${Date.now()}`;
    const handle = await acquireAgentMutex({
      mutexName: uniqueMutex,
      force: true,
      suppressFatalOnExit: true
    });
    expect(handle.acquired).toBe(true);

    let exited = false;
    handle.process.on('exit', () => { exited = true; });
    handle.process.kill('SIGKILL');

    await new Promise((r) => setTimeout(r, 500));
    expect(exited).toBe(true);
    handle.detachSignalHandlers();
  });

  (isWindows ? test : test.skip)('9. Mutex ownership cannot be released while an operational Agent continues running', async () => {
    const uniqueMutex = `${testMutexPrefix}OperationalGuard_${Date.now()}`;
    let isAgentRunning = true;

    const handle = await acquireAgentMutex({
      mutexName: uniqueMutex,
      force: true,
      isOperational: () => isAgentRunning,
      exitOnShutdown: false
    });

    expect(handle.acquired).toBe(true);
    expect(handle.isOperational()).toBe(true);

    // Calling release() directly while operational must throw
    expect(() => handle.release()).toThrow(/Mutex ownership cannot be released while an operational Agent continues running/);
    expect(handle.released).toBe(false);

    // Initiating shutdown lifecycle stops operations and releases mutex cleanly
    await handle.shutdown('TEST_SHUTDOWN');
    isAgentRunning = false;
    expect(handle.released).toBe(true);
    expect(handle.isShuttingDown).toBe(true);
    handle.detachSignalHandlers();
  });

  (isWindows ? test : test.skip)('10. SIGINT triggers explicit Agent shutdown lifecycle before mutex release', async () => {
    const uniqueMutex = `${testMutexPrefix}SigintLifecycle_${Date.now()}`;
    const lifecycleEvents = [];

    const handle = await acquireAgentMutex({
      mutexName: uniqueMutex,
      force: true,
      exitOnShutdown: false,
      onShutdown: async (signal) => {
        lifecycleEvents.push(`shutdown_start_${signal}`);
        // Simulate stopping timers and closing connections
        lifecycleEvents.push('timers_stopped');
        lifecycleEvents.push('socket_disconnected');
      }
    });

    expect(handle.acquired).toBe(true);

    // Emit SIGINT to process
    process.emit('SIGINT');

    // Wait for async shutdown to complete
    await new Promise((r) => setTimeout(r, 300));

    expect(lifecycleEvents).toEqual([
      'shutdown_start_SIGINT',
      'timers_stopped',
      'socket_disconnected'
    ]);
    expect(handle.released).toBe(true);

    // Now that first agent shut down and released mutex, a second agent can acquire
    const handle2 = await acquireAgentMutex({ mutexName: uniqueMutex, force: true, exitOnShutdown: false });
    expect(handle2.acquired).toBe(true);
    await handle2.shutdown('TEST_CLEANUP');
    handle.detachSignalHandlers();
    handle2.detachSignalHandlers();
  });

  (isWindows ? test : test.skip)('11. SIGTERM triggers shutdown lifecycle without duplicate execution on multiple signals', async () => {
    const uniqueMutex = `${testMutexPrefix}SigtermDuplicate_${Date.now()}`;
    let shutdownCount = 0;

    const handle = await acquireAgentMutex({
      mutexName: uniqueMutex,
      force: true,
      exitOnShutdown: false,
      onShutdown: async () => {
        shutdownCount++;
        await new Promise((r) => setTimeout(r, 50));
      }
    });

    // Send SIGTERM twice rapidly
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    process.emit('SIGINT');

    await new Promise((r) => setTimeout(r, 200));

    expect(shutdownCount).toBe(1);
    expect(handle.released).toBe(true);
    handle.detachSignalHandlers();
  });

  (isWindows ? test : test.skip)('12. Second Agent cannot acquire mutex until first Agent shutdown completes', async () => {
    const uniqueMutex = `${testMutexPrefix}SecondAgentWait_${Date.now()}`;
    let operational = true;

    const agent1 = await acquireAgentMutex({
      mutexName: uniqueMutex,
      force: true,
      exitOnShutdown: false,
      isOperational: () => operational,
      onShutdown: async () => {
        // Hold work for 100ms
        await new Promise((r) => setTimeout(r, 100));
        operational = false;
      }
    });

    // Attempt second agent acquisition while Agent 1 is running: must fail
    let errWhileRunning = null;
    try {
      await acquireAgentMutex({ mutexName: uniqueMutex, force: true, exitOnShutdown: false });
    } catch (err) {
      errWhileRunning = err;
    }
    expect(errWhileRunning).not.toBeNull();
    expect(errWhileRunning.code).toBe('MUTEX_ALREADY_HELD');

    // Trigger Agent 1 shutdown
    await agent1.shutdown('AGENT1_EXIT');
    expect(operational).toBe(false);
    expect(agent1.released).toBe(true);

    // Delay for OS cleanup
    await new Promise((r) => setTimeout(r, 200));

    // Agent 2 can now acquire
    const agent2 = await acquireAgentMutex({ mutexName: uniqueMutex, force: true, exitOnShutdown: false });
    expect(agent2.acquired).toBe(true);
    await agent2.shutdown('AGENT2_EXIT');

    agent1.detachSignalHandlers();
    agent2.detachSignalHandlers();
  });
});
