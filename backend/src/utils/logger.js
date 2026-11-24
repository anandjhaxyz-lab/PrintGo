const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const SENSITIVE_KEY_PATTERN = /^(?:password|pass|token|secret|jwt|machinekey|x-machine-key|x-client-secret|authorization|cashfree_secret_key|admin_pass|database_url)$/i;

const redactStringSecrets = (value) => {
  if (typeof value !== 'string') return value;
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/gi, '$1***REDACTED***')
    .replace(/(cfsk_(?:ma_)?(?:test|prod)_)[A-Za-z0-9_]+/gi, '$1***REDACTED***')
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi, '$1***REDACTED***$2');
};

const sanitizeLogValue = (val, seen = new WeakSet()) => {
  if (typeof val === 'string') return redactStringSecrets(val);
  if (!val || typeof val !== 'object') return val;
  if (seen.has(val)) return '[Circular]';
  seen.add(val);

  if (Array.isArray(val)) {
    return val.map((item) => sanitizeLogValue(item, seen));
  }

  const sanitized = {};
  for (const [k, v] of Object.entries(val)) {
    if (SENSITIVE_KEY_PATTERN.test(k) || k.toLowerCase().includes('secret') || k.toLowerCase().includes('password')) {
      sanitized[k] = '***REDACTED***';
    } else {
      sanitized[k] = sanitizeLogValue(v, seen);
    }
  }
  return sanitized;
};

const redactSecretsFormat = winston.format((info) => {
  const result = sanitizeLogValue({ ...info });
  if (info.message !== undefined) {
    result.message = sanitizeLogValue(info.message);
  }
  if (info.stack !== undefined) {
    result.stack = sanitizeLogValue(info.stack);
  }
  return Object.assign(info, result);
});

// P2-004: Structured logging using Winston
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    redactSecretsFormat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'printgo-backend' },
  transports: [
    new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log') })
  ]
});

// Stream structured JSON logs to stdout/stderr in production (e.g. Render Live Logs)
// and colorized logs in non-production environments.
if (process.env.NODE_ENV === 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      redactSecretsFormat(),
      winston.format.json()
    )
  }));
} else {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
        let metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
        // If meta is just the service name, hide it to reduce clutter
        if (Object.keys(meta).length === 1 && meta.service) metaStr = '';
        return `[${level}] ${timestamp} - ${stack || message} ${metaStr}`;
      })
    )
  }));
}

module.exports = logger;
