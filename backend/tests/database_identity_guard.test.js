const { assertDatabaseIdentity, LOCAL_IDENTITY, CLOUD_KEYS } = require('../src/utils/databaseIdentityGuard');

function prismaFor(identity) {
  return { $queryRawUnsafe: jest.fn(async () => [identity]) };
}

const stagingEnv = {
  NODE_ENV: 'staging',
  DATABASE_URL: 'postgresql://test-user:test-password@dpg-dbqn7pifngtc7384j0hg-a:5432/printgo_staging',
  [CLOUD_KEYS.host]: 'dpg-dbqn7pifngtc7384j0hg-a',
  [CLOUD_KEYS.name]: 'printgo_staging',
  [CLOUD_KEYS.port]: '5432'
};

const stagingIdentity = { database_name: 'printgo_staging', server_port: 5432 };

describe('fail-closed database identity guard', () => {
  test('accepts the explicitly allowlisted staging database endpoint', async () => {
    const prisma = prismaFor(stagingIdentity);
    await expect(assertDatabaseIdentity({ env: stagingEnv, prisma })).resolves.toEqual({
      host: 'dpg-dbqn7pifngtc7384j0hg-a',
      name: 'printgo_staging',
      port: 5432
    });
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  test('rejects staging when allowlist settings are missing before querying', async () => {
    const prisma = prismaFor({});
    await expect(assertDatabaseIdentity({ env: { NODE_ENV: 'staging' }, prisma }))
      .rejects.toThrow('missing required allowlist setting');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('rejects a mismatched database name in the URL', async () => {
    const prisma = prismaFor(stagingIdentity);
    const env = { ...stagingEnv, DATABASE_URL: 'postgresql://u:p@dpg-dbqn7pifngtc7384j0hg-a:5432/printgo_staging_wcbn' };
    await expect(assertDatabaseIdentity({ env, prisma }))
      .rejects.toThrow('rejected configured DATABASE_URL endpoint');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('rejects a mismatched configured hostname', async () => {
    const prisma = prismaFor(stagingIdentity);
    const env = { ...stagingEnv, DATABASE_URL: 'postgresql://u:p@other-db:5432/printgo_staging' };
    await expect(assertDatabaseIdentity({ env, prisma }))
      .rejects.toThrow('rejected configured DATABASE_URL endpoint');
  });

  test('rejects a mismatched configured port', async () => {
    const prisma = prismaFor(stagingIdentity);
    const env = { ...stagingEnv, DATABASE_URL: 'postgresql://u:p@dpg-dbqn7pifngtc7384j0hg-a:5433/printgo_staging' };
    await expect(assertDatabaseIdentity({ env, prisma }))
      .rejects.toThrow('rejected configured DATABASE_URL endpoint');
  });

  test('rejects a runtime database name mismatch', async () => {
    const prisma = prismaFor({ database_name: 'printgo_staging_wcbn', server_port: 5432 });
    await expect(assertDatabaseIdentity({ env: stagingEnv, prisma }))
      .rejects.toThrow('Database identity guard rejected connection');
  });

  test('rejects a runtime port mismatch', async () => {
    const prisma = prismaFor({ database_name: 'printgo_staging', server_port: 5433 });
    await expect(assertDatabaseIdentity({ env: stagingEnv, prisma }))
      .rejects.toThrow('Database identity guard rejected connection');
  });

  test('production also requires an explicit allowlist', async () => {
    const prisma = prismaFor({});
    await expect(assertDatabaseIdentity({ env: { NODE_ENV: 'production' }, prisma }))
      .rejects.toThrow('missing required allowlist setting');
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('local development remains pinned to the disposable target identity', async () => {
    const prisma = prismaFor({ database_name: LOCAL_IDENTITY.name, server_port: LOCAL_IDENTITY.port });
    const env = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://test-user:test-password@127.0.0.1:5433/printgo_disposable_target'
    };
    await expect(assertDatabaseIdentity({ env, prisma }))
      .resolves.toMatchObject(LOCAL_IDENTITY);
  });

  test('local development rejects non-disposable databases', async () => {
    const prisma = prismaFor({ database_name: 'printgo_e2e_phase2_db', server_port: 55433 });
    const env = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://test-user:test-password@127.0.0.1:55433/printgo_e2e_phase2_db'
    };
    await expect(assertDatabaseIdentity({ env, prisma }))
      .rejects.toThrow('rejected configured DATABASE_URL endpoint');
  });
});
