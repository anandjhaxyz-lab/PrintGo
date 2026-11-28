function normalizeText(value, maxLength = 2000) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function buildSubprocessDiagnostic(category, error, stderr, timeoutMs) {
  const numericCode = error && typeof error.code === 'number' ? error.code : null;
  const code = error && typeof error.code === 'string' ? error.code : null;
  const signal = error && error.signal ? String(error.signal) : null;
  const timedOut = Boolean(
    (error && error.killed && signal) ||
    code === 'ETIMEDOUT' ||
    (error && error.errno === 'ETIMEDOUT')
  );

  return {
    category: String(category),
    exitCode: numericCode,
    errorCode: code,
    errno: error && error.errno ? String(error.errno) : null,
    syscall: error && error.syscall ? String(error.syscall) : null,
    signal,
    killed: Boolean(error && error.killed),
    timedOut,
    timeoutMs: Number.isInteger(timeoutMs) ? timeoutMs : null,
    message: normalizeText(error && error.message, 500),
    stderr: normalizeText(stderr || (error && error.stderr), 2000)
  };
}

function formatSubprocessDiagnostic(diagnostic) {
  return JSON.stringify(diagnostic);
}

module.exports = {
  buildSubprocessDiagnostic,
  formatSubprocessDiagnostic,
  normalizeText
};
