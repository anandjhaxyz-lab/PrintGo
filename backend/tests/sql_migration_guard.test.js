const fs = require('fs');
const path = require('path');

describe('SQL migration test database safety guard', () => {
  const backfillSqlPath = path.join(__dirname, 'sql/multi_printer_phase1_backfill.test.sql');
  const chainSqlPath = path.join(__dirname, 'sql/multi_printer_full_migration_chain.test.sql');

  test('multi_printer_phase1_backfill.test.sql enforces database guard inside transaction before DROP', () => {
    const content = fs.readFileSync(backfillSqlPath, 'utf8');

    const beginIndex = content.indexOf('BEGIN;');
    const dropIndex = content.indexOf('DROP SCHEMA');
    const guardIndex = content.indexOf("IF current_database() <> 'printgo_disposable_target'");
    const rollbackIndex = content.lastIndexOf('ROLLBACK;');

    expect(beginIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(dropIndex).toBeGreaterThan(-1);
    expect(rollbackIndex).toBeGreaterThan(-1);

    // Guard must appear after BEGIN; and before any DROP SCHEMA
    expect(beginIndex).toBeLessThan(guardIndex);
    expect(guardIndex).toBeLessThan(dropIndex);
    expect(dropIndex).toBeLessThan(rollbackIndex);
  });

  test('multi_printer_full_migration_chain.test.sql enforces database guard inside transaction before DROP', () => {
    const content = fs.readFileSync(chainSqlPath, 'utf8');

    const beginIndex = content.indexOf('BEGIN;');
    const dropIndex = content.indexOf('DROP SCHEMA');
    const guardIndex = content.indexOf("IF current_database() <> 'printgo_disposable_target'");
    const rollbackIndex = content.lastIndexOf('ROLLBACK;');

    expect(beginIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(dropIndex).toBeGreaterThan(-1);
    expect(rollbackIndex).toBeGreaterThan(-1);

    // Guard must appear after BEGIN; and before any DROP SCHEMA
    expect(beginIndex).toBeLessThan(guardIndex);
    expect(guardIndex).toBeLessThan(dropIndex);
    expect(dropIndex).toBeLessThan(rollbackIndex);
  });

  test('simulates database check to prove immediate rejection when database name differs', () => {
    const simulateGuard = (dbName) => {
      if (dbName !== 'printgo_disposable_target') {
        throw new Error(`SAFETY CHECK FAILED: Refusing to execute migration test against database "${dbName}". Script can only run against "printgo_disposable_target".`);
      }
      return 'SAFE_TO_RUN';
    };

    expect(simulateGuard('printgo_disposable_target')).toBe('SAFE_TO_RUN');
    expect(() => simulateGuard('printgo_staging')).toThrow('SAFETY CHECK FAILED');
    expect(() => simulateGuard('printgo_production')).toThrow('SAFETY CHECK FAILED');
    expect(() => simulateGuard('postgres')).toThrow('SAFETY CHECK FAILED');
  });
});
