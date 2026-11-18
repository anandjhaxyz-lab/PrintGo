const ENV_KEYS = [
  'NODE_ENV',
  'QUEUE_REDIS_REQUIRED',
  'REDIS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_USERNAME',
  'REDIS_PASSWORD',
  'REDIS_TLS'
];

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const restoreEnv = () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
};

describe('PrintGo Redis infrastructure safety', () => {
  let RedisMock;

  beforeEach(() => {
    jest.resetModules();

    for (const key of ENV_KEYS) delete process.env[key];
    process.env.NODE_ENV = 'test';

    RedisMock = jest.fn(function RedisStub(...args) {
      this.args = args;
      this.status = 'ready';
      this.listeners = {};
      this.on = jest.fn((event, handler) => {
        this.listeners[event] = handler;
        return this;
      });
      this.once = jest.fn((event, handler) => {
        if (event === 'ready' && this.status === 'ready') handler();
        else this.listeners[event] = handler;
        return this;
      });
      this.removeListener = jest.fn((event) => {
        delete this.listeners[event];
        return this;
      });
      this.ping = jest.fn().mockResolvedValue('PONG');
      this.quit = jest.fn().mockResolvedValue('OK');
      this.duplicate = jest.fn(() => new RedisMock(...args));
    });

    jest.doMock('ioredis', () => RedisMock);
  });

  afterEach(() => {
    jest.dontMock('ioredis');
    jest.resetModules();
    restoreEnv();
  });

  test('prefers Render REDIS_URL and passes BullMQ worker retry settings', () => {
    process.env.REDIS_URL = 'redis://red-example:6379';

    const redis = require('../src/services/redisClient');

    expect(RedisMock).toHaveBeenCalledTimes(1);
    expect(RedisMock.mock.calls[0][0]).toBe('redis://red-example:6379');
    expect(RedisMock.mock.calls[0][1]).toMatchObject({
      maxRetriesPerRequest: null,
      connectTimeout: 10000,
      enableReadyCheck: true
    });
    expect(redis.getRedisHealth()).toEqual({
      configured: true,
      status: 'ready',
      ready: true
    });
  });

  test('keeps legacy REDIS_HOST configuration compatible', () => {
    process.env.REDIS_HOST = 'redis.internal';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_USERNAME = 'default';
    process.env.REDIS_PASSWORD = 'not-a-real-secret';

    require('../src/services/redisClient');

    expect(RedisMock.mock.calls[0][0]).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      username: 'default',
      password: 'not-a-real-secret',
      maxRetriesPerRequest: null
    });
  });

  test('rejects malformed REDIS_URL values instead of silently disabling Redis', () => {
    process.env.REDIS_URL = 'http://not-redis.example';

    expect(() => require('../src/services/redisClient')).toThrow(
      'REDIS_URL must use redis:// or rediss://.'
    );
  });

  test('fails startup when production has no Redis configuration', () => {
    process.env.NODE_ENV = 'production';

    expect(() => require('../src/services/redisClient')).toThrow(
      'Redis is required in production.'
    );
  });

  test('allows the in-memory configuration only in non-production runtimes', () => {
    const redis = require('../src/services/redisClient');

    expect(redis.connection).toBeNull();
    expect(redis.getRedisHealth()).toEqual({
      configured: false,
      status: 'disabled',
      ready: false
    });
  });
});

describe('PrintGo production print queue fail-closed behavior', () => {
  const queuePrisma = {
    printJob: {
      findUnique: jest.fn(),
      updateMany: jest.fn()
    }
  };

  const makeQueueMocks = (addImpl = jest.fn().mockResolvedValue({ id: 'job-1' }), workerReady = jest.fn().mockResolvedValue()) => {
    const queue = {
      add: addImpl,
      waitUntilReady: jest.fn().mockResolvedValue(),
      close: jest.fn().mockResolvedValue()
    };
    const worker = {
      on: jest.fn(),
      waitUntilReady: workerReady,
      isRunning: jest.fn().mockReturnValue(true),
      close: jest.fn().mockResolvedValue()
    };

    return {
      queue,
      worker,
      Queue: jest.fn(() => queue),
      Worker: jest.fn(() => worker)
    };
  };

  let originalNodeEnv;
  let originalRequired;

  beforeEach(() => {
    jest.resetModules();
    originalNodeEnv = process.env.NODE_ENV;
    originalRequired = process.env.QUEUE_REDIS_REQUIRED;
    process.env.NODE_ENV = 'production';
    delete process.env.QUEUE_REDIS_REQUIRED;
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalRequired === undefined) delete process.env.QUEUE_REDIS_REQUIRED;
    else process.env.QUEUE_REDIS_REQUIRED = originalRequired;
    jest.resetModules();
  });

  test('rejects a missing Redis connection instead of loading an in-memory production queue', () => {
    jest.doMock('bullmq', () => ({
      Queue: jest.fn(),
      Worker: jest.fn()
    }));
    jest.doMock('../src/services/redisClient', () => ({ connection: null }));
    jest.doMock('../src/utils/prisma', () => queuePrisma);

    expect(() => require('../src/services/queueService')).toThrow(
      'PrintGo production queue requires Redis;'
    );
  });

  test('does not call direct physical dispatch when durable enqueue fails in production', async () => {
    const mocks = makeQueueMocks(jest.fn().mockRejectedValue(new Error('Redis unavailable')));
    const connection = { status: 'ready' };

    jest.doMock('bullmq', () => ({
      Queue: mocks.Queue,
      Worker: mocks.Worker
    }));
    jest.doMock('../src/services/redisClient', () => ({ connection }));
    jest.doMock('../src/utils/prisma', () => queuePrisma);

    const service = require('../src/services/queueService');
    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };

    await service.initWorker(io);
    await expect(service.startPrintingProcess('prod-job-001', io)).rejects.toThrow(
      'no in-memory dispatch was attempted'
    );

    expect(queuePrisma.printJob.findUnique).not.toHaveBeenCalled();
    expect(queuePrisma.printJob.updateMany).not.toHaveBeenCalled();

    await service.closeQueueService();
  });

  test('fails worker initialization when the durable worker cannot become ready in production', async () => {
    const mocks = makeQueueMocks(
      jest.fn().mockResolvedValue({ id: 'job-1' }),
      jest.fn().mockRejectedValue(new Error('worker connection failed'))
    );

    jest.doMock('bullmq', () => ({
      Queue: mocks.Queue,
      Worker: mocks.Worker
    }));
    jest.doMock('../src/services/redisClient', () => ({ connection: { status: 'ready' } }));
    jest.doMock('../src/utils/prisma', () => queuePrisma);

    const service = require('../src/services/queueService');

    await expect(service.initWorker({})).rejects.toThrow(
      'Durable print worker failed to become ready'
    );
    await service.closeQueueService();
  });
});
