/**
 * PrintGo Printer Agent — Discovery-Only Safety Mode Guard
 *
 * Enforces strict fail-closed isolation preventing any print job (physical or simulated)
 * from being downloaded, spooled, or executed when DISCOVERY_ONLY mode is active.
 *
 * Requirements:
 * - Reject every physical_print_job immediately at the entrypoint.
 * - Zero PDF downloads, zero temp files, zero ptp.print calls, zero spooler calls.
 * - Zero journal transitions written for print jobs.
 * - Zero simulation success reporting.
 * - Return explicit non-successful rejection response (print_spooler_error).
 * - Preserve normal printer discovery, telemetry, and inventory reporting.
 * - Fail closed if configuration is missing, empty, invalid, or ambiguous.
 * - Never log machine keys, authentication tokens, customer PDF contents, or sensitive paths.
 */

'use strict';

/**
 * Parses and validates the discovery-only configuration from environment and CLI flags.
 *
 * Rules:
 * 1. CLI flag `--discovery-only` enables strict discovery-only mode.
 * 2. Explicit DISCOVERY_ONLY=true, 1, or yes enables strict discovery-only mode.
 * 3. Explicit false, 0, or no disables discovery-only mode ONLY when deliberately configured.
 * 4. Missing or empty configuration FAILS CLOSED by defaulting to discovery-only mode.
 * 5. Invalid or ambiguous values FAIL CLOSED (isValid: false, isDiscoveryOnly: true).
 *
 * @param {object} [env=process.env]
 * @param {string[]} [argv=process.argv]
 * @returns {{ isDiscoveryOnly: boolean, isValid: boolean, source: string, error?: string }}
 */
function parseDiscoveryModeConfig(env = process.env, argv = process.argv) {
  // Check CLI argument first
  const hasCliFlag = Array.isArray(argv) && argv.includes('--discovery-only');
  if (hasCliFlag) {
    return {
      isDiscoveryOnly: true,
      isValid: true,
      source: 'cli'
    };
  }

  const rawEnv = env && env.DISCOVERY_ONLY !== undefined && env.DISCOVERY_ONLY !== null
    ? String(env.DISCOVERY_ONLY).trim()
    : undefined;

  // Missing or empty configuration: FAIL CLOSED (enable discovery-only mode)
  if (rawEnv === undefined || rawEnv === '') {
    return {
      isDiscoveryOnly: true,
      isValid: true,
      source: 'default_fail_closed',
      note: 'Missing or empty DISCOVERY_ONLY configuration; defaulted to discovery-only mode for safety.'
    };
  }

  const normalized = rawEnv.toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) {
    return {
      isDiscoveryOnly: true,
      isValid: true,
      source: 'env'
    };
  }

  if (['false', '0', 'no'].includes(normalized)) {
    return {
      isDiscoveryOnly: false,
      isValid: true,
      source: 'env'
    };
  }

  // Any unrecognized or ambiguous value FAILS CLOSED
  return {
    isDiscoveryOnly: true,
    isValid: false,
    source: 'env',
    invalidValue: rawEnv,
    error: `Ambiguous or invalid DISCOVERY_ONLY value "${rawEnv}". Allowed values: true, false, 1, 0, yes, no.`
  };
}

/**
 * Evaluates whether a physical print job can safely proceed or must be rejected.
 *
 * @param {object} jobData - The print job event payload
 * @param {object} config - Result of parseDiscoveryModeConfig()
 * @returns {{ blocked: boolean, reason?: string, deviceBinding: object }}
 */
function evaluatePrintJobSafety(jobData, config) {
  const deviceBinding = (jobData?.printerDeviceId !== undefined && jobData?.printerDeviceId !== null) ? {
    printerDeviceId: jobData.printerDeviceId,
    windowsPrinterName: jobData.windowsPrinterName
  } : {};

  if (!config || !config.isValid) {
    const errorDetail = config?.error || 'Invalid or unverified discovery-only configuration';
    return {
      blocked: true,
      reason: `Configuration Error: ${errorDetail}. Fails closed: print dispatch refused.`,
      deviceBinding
    };
  }

  if (config.isDiscoveryOnly) {
    const detail = config.source === 'default_fail_closed'
      ? 'Agent defaulted to STRICT DISCOVERY_ONLY mode (missing or empty DISCOVERY_ONLY configuration). All physical and simulated print dispatches are refused.'
      : 'Agent is operating in STRICT DISCOVERY_ONLY mode. All physical and simulated print dispatches are refused.';
    return {
      blocked: true,
      reason: detail,
      deviceBinding
    };
  }

  return {
    blocked: false,
    deviceBinding
  };
}

/**
 * Creates a guarded physical_print_job handler wrapper.
 *
 * @param {object} options
 * @param {object} options.config - Discovery mode config
 * @param {object} options.socket - Socket.IO client instance
 * @param {function} options.onSafeJob - Downstream processor called only when NOT blocked
 * @param {object} [options.logger=console]
 * @returns {function(object): Promise<void>|void}
 */
function createGuardedPrintJobHandler(options) {
  const { config, socket, onSafeJob, logger = console } = options;

  return function handleGuardedPrintJob(jobData) {
    const jobId = jobData?.jobId;
    if (!jobId || typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      logger.error(`❌ REJECTED Job: Invalid jobId format (potential injection): ${jobId}`);
      return;
    }

    const safetyCheck = evaluatePrintJobSafety(jobData, config);
    if (safetyCheck.blocked) {
      logger.warn(`🛑 DISCOVERY_ONLY GUARD: Refused print job ${jobId}. ${safetyCheck.reason}`);
      if (socket && typeof socket.emit === 'function') {
        socket.emit('print_spooler_error', {
          jobId,
          error: safetyCheck.reason,
          ...safetyCheck.deviceBinding
        });
      }
      return;
    }

    return onSafeJob(jobData);
  };
}

module.exports = {
  parseDiscoveryModeConfig,
  evaluatePrintJobSafety,
  createGuardedPrintJobHandler
};
