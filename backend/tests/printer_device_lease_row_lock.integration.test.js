const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

function assertDisposableDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for the PostgreSQL lease row-lock integration test.');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error(`DATABASE_URL is malformed: ${error.message}`);
  }

  const databaseName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) ||
      databaseName !== 'printgo_disposable_target') {
    throw new Error(
      'Safety stop: lease row-lock integration tests may run only against local printgo_disposable_target.'
    );
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function within(promise, label, timeoutMs = 5000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

describe('PostgreSQL PrinterDevice row-lock concurrency', () => {
  let firstClient;
  let secondClient;
  let schemaName;
  let lockSql;

  beforeAll(async () => {
    assertDisposableDatabaseUrl();

    schemaName = `lease_lock_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
    firstClient = new PrismaClient();
    secondClient = new PrismaClient();

    await firstClient.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    await firstClient.$executeRawUnsafe(
      `CREATE TABLE "${schemaName}"."LockProbe" ("id" TEXT PRIMARY KEY)`
    );
    await firstClient.$executeRawUnsafe(
      `INSERT INTO "${schemaName}"."LockProbe" ("id") VALUES ('device-a'), ('device-b')`
    );

    lockSql = `SELECT "id" FROM "${schemaName}"."LockProbe" WHERE "id" = $1 FOR UPDATE`;
  }, 15000);

  afterAll(async () => {
    if (firstClient && schemaName) {
      try {
        await firstClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        await Promise.all([
          firstClient.$disconnect(),
          secondClient?.$disconnect()
        ].filter(Boolean));
      }
      return;
    }

    await Promise.all([
      firstClient?.$disconnect(),
      secondClient?.$disconnect()
    ].filter(Boolean));
  }, 15000);

  test('serializes two transactions that lock the same physical PrinterDevice row', async () => {
    const firstLocked = deferred();
    const releaseFirst = deferred();
    const secondLocked = deferred();
    let secondTransaction;
    let secondAcquired = false;

    const firstTransaction = firstClient.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(lockSql, 'device-a');
      firstLocked.resolve();
      await releaseFirst.promise;
    });

    try {
      await within(firstLocked.promise, 'first transaction row lock');
      secondTransaction = secondClient.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(lockSql, 'device-a');
        secondAcquired = true;
        secondLocked.resolve();
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(secondAcquired).toBe(false);

      releaseFirst.resolve();
      await within(Promise.all([firstTransaction, secondTransaction]), 'serialized transactions');
      await within(secondLocked.promise, 'second transaction row lock');
      expect(secondAcquired).toBe(true);
    } finally {
      releaseFirst.resolve();
      await Promise.all([
        firstTransaction.catch(() => {}),
        secondTransaction?.catch(() => {})
      ].filter(Boolean));
    }
  }, 15000);

  test('allows different physical PrinterDevice rows to be locked concurrently', async () => {
    const firstLocked = deferred();
    const releaseFirst = deferred();
    const secondLocked = deferred();

    const firstTransaction = firstClient.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(lockSql, 'device-a');
      firstLocked.resolve();
      await releaseFirst.promise;
    });

    try {
      await within(firstLocked.promise, 'first device row lock');
      const secondTransaction = secondClient.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(lockSql, 'device-b');
        secondLocked.resolve();
      });

      await within(secondLocked.promise, 'independent second device row lock');
      expect(true).toBe(true);
      releaseFirst.resolve();
      await within(Promise.all([firstTransaction, secondTransaction]), 'independent row-lock transactions');
    } finally {
      releaseFirst.resolve();
      await firstTransaction.catch(() => {});
    }
  }, 15000);
});
