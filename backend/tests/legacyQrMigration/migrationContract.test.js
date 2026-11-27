const fs = require('fs');
const path = require('path');
const migration = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261127000017_legacy_printer_qr_bindings/migration.sql'), 'utf8');
const repairMigration = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261128000018_legacy_printer_qr_binding_restrict_delete_actions/migration.sql'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../../prisma/schema.prisma'), 'utf8');
describe('legacy QR migration SQL contract (static isolated)', () => {
  test('creates binding table with required identity and audit fields', () => {
    for (const field of ['printerQrId','machineId','printerDeviceId','status','reason','approvedAt','approvedBy','revokedAt','revokedBy','revokedReason']) {
      expect(migration).toContain('"' + field + '"');
    }
    expect(migration).toContain('CREATE TABLE "LegacyPrinterQrBinding"');
  });
  test('enforces one binding record per legacy QR', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX "LegacyPrinterQrBinding_printerQrId_key"');
  });
  test('enforces QR, machine and target-device referential integrity', () => {
    expect(migration).toContain('REFERENCES "PrinterQr"("id")');
    expect(migration).toContain('REFERENCES "Machine"("id")');
    expect(migration).toContain('REFERENCES "PrinterDevice"("id")');
  });
  test('preserves audit tombstones when a parent QR or Machine is deleted', () => {
    expect(migration).toContain('"LegacyPrinterQrBinding_printerQrId_fkey" FOREIGN KEY ("printerQrId") REFERENCES "PrinterQr"("id") ON DELETE RESTRICT');
    expect(migration).toContain('"LegacyPrinterQrBinding_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT');
    expect(schema).toContain('printerQr       PrinterQr     @relation(fields: [printerQrId], references: [id], onDelete: Restrict)');
    expect(schema).toContain('machine         Machine       @relation(fields: [machineId], references: [id], onDelete: Restrict)');
  });
  test('disposable PostgreSQL regression script checks all three ON DELETE RESTRICT constraints and database identity', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../sql/legacy_printer_qr_binding_constraints.test.sql'), 'utf8');
    expect(sql).toContain("current_database()");
    expect(sql).toContain("printgo_disposable_target");
    for (const name of ['LegacyPrinterQrBinding_printerQrId_fkey','LegacyPrinterQrBinding_machineId_fkey','LegacyPrinterQrBinding_printerDeviceId_fkey']) {
      expect(sql).toContain(name);
    }
    expect(sql).toContain("v_delete_action <> 'r'");
    expect(sql).toContain('ROLLBACK;');
  });

  test('follow-up repair migration rebuilds all three foreign keys with ON DELETE RESTRICT', () => {
    for (const name of ['LegacyPrinterQrBinding_printerQrId_fkey','LegacyPrinterQrBinding_machineId_fkey','LegacyPrinterQrBinding_printerDeviceId_fkey']) {
      expect(repairMigration).toContain('DROP CONSTRAINT IF EXISTS "' + name + '"');
      expect(repairMigration).toContain('ADD CONSTRAINT "' + name + '"');
    }
    expect((repairMigration.match(/ON DELETE RESTRICT/g) || []).length).toBe(3);
    expect(repairMigration).toContain('BEGIN;');
    expect(repairMigration).toContain('COMMIT;');
    expect(repairMigration).not.toMatch(/UPDATE\s+"?LegacyPrinterQrBinding"?/i);
    expect(repairMigration).not.toMatch(/DELETE\s+FROM/i);
  });

  test('does not touch QR token, sessions, or existing printer mappings', () => {
    expect(migration).not.toMatch(/UPDATE\s+"?PrinterQr"?/i);
    expect(migration).not.toMatch(/UPDATE\s+"?Session"?/i);
    expect(migration).not.toMatch(/publicCode/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });
});

describe('legacy QR runtime integration contract (static)', () => {
  const service = fs.readFileSync(path.join(__dirname, '../../src/services/printerQr.service.js'), 'utf8');
  test('resolves aliases for machine-level legacy QR and uses child device in session', () => {
    expect(service).toContain('legacyPlaceholderDevice || !lockedQr.printerDeviceId');
    expect(service).toContain('printerDeviceId: legacyAliasDevice ? legacyAliasDevice.id');
    expect(service).toContain('getPrinterDeviceAvailability(qr.machine_id, session.printerDeviceId, prisma)');
  });
  test('public pre-scan metadata resolves approved alias and device-scoped telemetry', () => {
    expect(service).toContain('prisma.legacyPrinterQrBinding.findUnique');
    expect(service).toContain('include: { printerDevice:');
    expect(service).toContain('getPrinterDeviceAvailability(qr.machine.id, effectiveDevice.id, prisma)');
    expect(service).toContain('Legacy QR alias is not active. Replace the QR before reuse.');
  });
});
