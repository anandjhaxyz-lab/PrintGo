/**
 * Fail-closed database identity verification.
 * Compare the configured DATABASE_URL endpoint (stable hostname) and the
 * database identity returned by PostgreSQL. Never log the URL or credentials.
 */
const LOCAL_IDENTITY = Object.freeze({
  host: '127.0.0.1',
  name: 'printgo_disposable_target',
  port: 5433
});

const CLOUD_KEYS = Object.freeze({
  host: 'PRINTGO_EXPECTED_DATABASE_HOST',
  name: 'PRINTGO_EXPECTED_DATABASE_NAME',
  port: 'PRINTGO_EXPECTED_DATABASE_PORT'
});

async function assertDatabaseIdentity({ env = process.env, prisma }) {
  if (!prisma || typeof prisma.$queryRawUnsafe !== 'function') {
    throw new Error('Database identity guard requires a Prisma client.');
  }

  const cloud = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  let expected;

  if (cloud) {
    const missing = Object.values(CLOUD_KEYS).filter((key) => !String(env[key] || '').trim());
    if (missing.length) {
      throw new Error(`Database identity guard: missing required allowlist setting(s): ${missing.join(', ')}.`);
    }

    expected = {
      host: String(env[CLOUD_KEYS.host]).trim().toLowerCase(),
      name: String(env[CLOUD_KEYS.name]).trim(),
      port: Number(env[CLOUD_KEYS.port])
    };
  } else {
    expected = LOCAL_IDENTITY;
  }

  if (!Number.isInteger(expected.port) || expected.port < 1 || expected.port > 65535) {
    throw new Error('Database identity guard: expected database port is invalid.');
  }

  let configured;
  try {
    const url = new URL(env.DATABASE_URL || '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('unsupported protocol');
    configured = {
      host: url.hostname.toLowerCase(),
      port: Number(url.port || 5432),
      name: decodeURIComponent(url.pathname.replace(/^\//, ''))
    };
  } catch {
    throw new Error('Database identity guard: DATABASE_URL is missing or invalid.');
  }

  if (
    configured.host !== expected.host ||
    configured.port !== expected.port ||
    configured.name !== expected.name
  ) {
    throw new Error('Database identity guard rejected configured DATABASE_URL endpoint.');
  }

  const rows = await prisma.$queryRawUnsafe(
    'SELECT current_database() AS database_name, inet_server_port() AS server_port;'
  );
  const row = rows && rows[0];
  const actual = {
    name: row && row.database_name,
    port: Number(row && row.server_port)
  };

  if (actual.name !== expected.name || actual.port !== expected.port) {
    throw new Error(
      `Database identity guard rejected connection: expected ${expected.name} on port ${expected.port}; received ${actual.name || 'unknown'} on port ${Number.isFinite(actual.port) ? actual.port : 'unknown'}.`
    );
  }

  return { host: configured.host, name: actual.name, port: actual.port };
}

module.exports = { assertDatabaseIdentity, LOCAL_IDENTITY, CLOUD_KEYS };
