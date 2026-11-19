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
    await firstClient.$executeRawUnsafe(
      `CREATE TABLE "${schemaName}"."DispatchLeaseProbe" (
        "printerDeviceId" TEXT PRIMARY KEY,
        "requestId" TEXT NOT NULL,
        "jobShortId" TEXT NOT NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "releasedAt" TIMESTAMPTZ
      )`
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
    let secondTransaction;
    let secondAcquired = false;

    const firstTransaction = firstClient.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(lockSql, 'device-a');
      firstLocked.resolve();
      await releaseFirst.promise;
    });

    try {
      await within(firstLocked.promise, 'first device row lock');
      secondTransaction = secondClient.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(lockSql, 'device-b');
        secondAcquired = true;
        secondLocked.resolve();
      });

      await within(secondLocked.promise, 'independent second device row lock');
      expect(secondAcquired).toBe(true);
      releaseFirst.resolve();
      await within(Promise.all([firstTransaction, secondTransaction]), 'independent row-lock transactions');
    } finally {
      releaseFirst.resolve();
      await Promise.all([
        firstTransaction.catch(() => {}),
        secondTransaction?.catch(() => {})
      ].filter(Boolean));
    }
  }, 15000);

  test('proves two concurrent transactions cannot authorize overlapping physical jobs on the same PrinterDevice', async () => {
    const conn1Locked = deferred();
    const releaseConn1 = deferred();
    const conn2Finished = deferred();
    let conn2Acquired = false;
    let conn1Outcome = null;
    let conn2Outcome = null;

    // Simulate Connection 1 attempting dispatch authorization for job-alpha
    const conn1Tx = firstClient.$transaction(async (tx) => {
      // 1. Lock PrinterDevice row
      await tx.$queryRawUnsafe(lockSql, 'device-a');
      conn1Locked.resolve();

      // 2. Query existing active lease
      const existing = await tx.$queryRawUnsafe(
        `SELECT * FROM "${schemaName}"."DispatchLeaseProbe" WHERE "printerDeviceId" = $1`,
        'device-a'
      );
      if (existing.length === 0 || (existing[0].expiresAt < new Date() && existing[0].releasedAt)) {
        // Hold lock briefly to simulate processing / agent emission
        await releaseConn1.promise;
        const expiresAt = new Date(Date.now() + 45000);
        await tx.$queryRawUnsafe(
          `INSERT INTO "${schemaName}"."DispatchLeaseProbe" ("printerDeviceId", "requestId", "jobShortId", "expiresAt", "releasedAt")
           VALUES ($1, $2, $3, $4, NULL)
           ON CONFLICT ("printerDeviceId") DO UPDATE
           SET "requestId" = $2, "jobShortId" = $3, "expiresAt" = $4, "releasedAt" = NULL`,
          'device-a', 'req-alpha', 'job-alpha', expiresAt
        );
        conn1Outcome = { allowed: true, jobId: 'job-alpha' };
      } else {
        conn1Outcome = { allowed: false, code: 'DEVICE_DISPATCH_IN_PROGRESS' };
      }
    });

    let conn2Tx;
    try {
      await within(conn1Locked.promise, 'connection 1 row lock');

      // In parallel, Connection 2 attempts dispatch authorization for job-beta on the SAME device
      conn2Tx = secondClient.$transaction(async (tx) => {
        // Connection 2 will BLOCK here waiting for Connection 1 to commit
        await tx.$queryRawUnsafe(lockSql, 'device-a');
        conn2Acquired = true;

        // Once unblocked, read current lease state
        const existing = await tx.$queryRawUnsafe(
          `SELECT * FROM "${schemaName}"."DispatchLeaseProbe" WHERE "printerDeviceId" = $1`,
          'device-a'
        );
        if (existing.length > 0 && existing[0].expiresAt > new Date() && !existing[0].releasedAt) {
          conn2Outcome = { allowed: false, code: 'DEVICE_DISPATCH_IN_PROGRESS', activeJob: existing[0].jobShortId };
        } else {
          conn2Outcome = { allowed: true, jobId: 'job-beta' };
        }
        conn2Finished.resolve();
      });

      // Verify Connection 2 is actively blocked by PostgreSQL row lock
      await new Promise((r) => setTimeout(r, 300));
      expect(conn2Acquired).toBe(false);

      // Release Connection 1 to write lease and commit
      releaseConn1.resolve();
      await within(conn1Tx, 'connection 1 commit');

      // Now Connection 2 acquires lock and evaluates
      await within(conn2Finished.promise, 'connection 2 completion');
      await conn2Tx;

      expect(conn2Acquired).toBe(true);
      expect(conn1Outcome).toEqual({ allowed: true, jobId: 'job-alpha' });
      expect(conn2Outcome).toEqual({
        allowed: false,
        code: 'DEVICE_DISPATCH_IN_PROGRESS',
        activeJob: 'job-alpha'
      });

      // Confirm only Job Alpha holds the physical device in the database
      const finalLease = await firstClient.$queryRawUnsafe(
        `SELECT * FROM "${schemaName}"."DispatchLeaseProbe" WHERE "printerDeviceId" = $1`,
        'device-a'
      );
      expect(finalLease).toHaveLength(1);
      expect(finalLease[0].jobShortId).toBe('job-alpha');
      expect(finalLease[0].releasedAt).toBeNull();
    } finally {
      releaseConn1.resolve();
      await Promise.all([
        conn1Tx.catch(() => {}),
        conn2Tx?.catch(() => {})
      ].filter(Boolean));
    }
  }, 15000);
});
