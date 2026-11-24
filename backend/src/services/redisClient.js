const Redis = require('ioredis');

const redisUrl = (process.env.REDIS_URL || '').trim();
const redisHost = (process.env.REDIS_HOST || '').trim();
const isRedisRequired =
  process.env.NODE_ENV === 'production' ||
  process.env.QUEUE_REDIS_REQUIRED === 'true';

let connection = null;

if (redisUrl) {
  if (!/^rediss?:\/\//i.test(redisUrl)) {
    throw new Error('REDIS_URL must use redis:// or rediss://.');
  }

  // Render Key Value provides an internal redis:// URL or an external rediss:// URL.
  connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null, // Required by BullMQ workers.
    connectTimeout: 10000,
    enableReadyCheck: true
  });
} else if (redisHost) {
  const useTls =
    process.env.REDIS_TLS === 'true' ||
    redisHost.toLowerCase().includes('upstash');

  connection = new Redis({
    host: redisHost,
    port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null, // Required by BullMQ workers.
    connectTimeout: 10000,
    enableReadyCheck: true,
    tls: useTls ? {} : undefined
  });
}

if (!connection && isRedisRequired) {
  throw new Error(
    'Redis is required in production. Configure REDIS_URL (recommended) or REDIS_HOST before starting PrintGo.'
  );
}

if (connection) {
  connection.on('error', (err) => {
    // Never log connection URLs or credentials.
    console.error('Redis connection error:', err.message);
  });
}

const waitForRedisReady = async (timeoutMs = 15000) => {
  if (!connection) {
    throw new Error('Redis is not configured.');
  }

  if (connection.status === 'ready') {
    return true;
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.removeListener('ready', onReady);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const timer = setTimeout(
      () => finish(new Error(`Redis did not become ready within ${timeoutMs}ms.`)),
      timeoutMs
    );

    connection.once('ready', onReady);
    if (connection.status === 'ready') finish();
  });

  return true;
};

const getRedisHealth = () => ({
  configured: Boolean(connection),
  status: connection ? connection.status : 'disabled',
  ready: Boolean(connection && connection.status === 'ready')
});

const closeRedisConnection = async () => {
  if (connection && connection.status !== 'end') {
    await connection.quit();
  }
};

module.exports = {
  connection,
  isRedisRequired,
  waitForRedisReady,
  getRedisHealth,
  closeRedisConnection
};
