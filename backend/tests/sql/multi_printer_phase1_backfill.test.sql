\set ON_ERROR_STOP on

-- Isolated pre-migration schema with representative legacy single-printer rows.
DROP SCHEMA IF EXISTS multi_printer_migration_test CASCADE;
BEGIN;
CREATE SCHEMA multi_printer_migration_test;
SET LOCAL search_path TO multi_printer_migration_test, public;

CREATE TABLE "Machine" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "printerModel" TEXT,
  "connectionType" TEXT
);

CREATE TABLE "PrinterQr" (
  "id" TEXT PRIMARY KEY,
  "publicCode" TEXT NOT NULL UNIQUE,
  "label" TEXT,
  "status" TEXT NOT NULL,
  "machineId" TEXT,
  "generatedBy" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokedBy" TEXT,
  "revokedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Simulate the existing partial index that Phase 1 must retain.
CREATE UNIQUE INDEX "printer_qrs_machine_id_active_unique"
  ON "PrinterQr"("machineId")
  WHERE "status" = 'ACTIVE' AND "machineId" IS NOT NULL;

CREATE TABLE "Session" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "machineId" TEXT,
  "printerQrId" TEXT,
  "paymentMode" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "PrintJob" (
  "id" TEXT PRIMARY KEY,
  "shortId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "cost" DOUBLE PRECISION NOT NULL,
  "machineId" TEXT,
  "paymentMode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "PrinterStatus" (
  "id" TEXT PRIMARY KEY,
  "machineId" TEXT NOT NULL,
  "isOnline" BOOLEAN NOT NULL DEFAULT TRUE,
  "paperStatus" TEXT NOT NULL DEFAULT 'OK',
  "tonerStatus" TEXT NOT NULL DEFAULT 'OK',
  "jamStatus" BOOLEAN NOT NULL DEFAULT FALSE,
  "connectionType" TEXT,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "Machine" ("id", "name", "printerModel", "connectionType") VALUES
  ('machine-a', 'Main Shop PC', 'Epson EcoTank L6460', 'USB'),
  ('machine-b', 'Second Shop PC', 'HP LaserJet', 'Network');

INSERT INTO "PrinterQr" ("id", "publicCode", "label", "status", "machineId") VALUES
  ('qr-a', 'legacy-public-token-a', 'Front Desk', 'ACTIVE', 'machine-a'),
  ('qr-b', 'legacy-public-token-b', 'Back Counter', 'ACTIVE', 'machine-b');

INSERT INTO "Session" ("id", "code", "status", "machineId", "printerQrId", "paymentMode", "expiresAt") VALUES
  ('session-a', 'SESSIONA12345', 'WAITING_FOR_MOBILE', 'machine-a', 'qr-a', 'CASH_AT_COUNTER', CURRENT_TIMESTAMP + INTERVAL '1 hour'),
  ('session-b', 'SESSIONB12345', 'WAITING_FOR_MOBILE', 'machine-b', NULL, 'CASHFREE_ONLINE', CURRENT_TIMESTAMP + INTERVAL '1 hour');

INSERT INTO "PrintJob" ("id", "shortId", "status", "cost", "machineId", "paymentMode") VALUES
  ('job-a', 'JOBA1234', 'COMPLETED', 12.50, 'machine-a', 'CASH_AT_COUNTER'),
  ('job-b', 'JOBB1234', 'PENDING_PAYMENT', 7.00, 'machine-b', 'CASHFREE_ONLINE');

INSERT INTO "PrinterStatus" ("id", "machineId", "isOnline", "paperStatus", "connectionType") VALUES
  ('status-a', 'machine-a', TRUE, 'OK', 'USB'),
  ('status-b', 'machine-b', FALSE, 'OUT', 'Network');

-- Apply the exact production migration under the isolated test schema.
\ir ../../prisma/migrations/20261119000012_add_printer_devices/migration.sql

DO $assert$
DECLARE
  device_count INTEGER;
  mapped_qr_count INTEGER;
  mapped_session_count INTEGER;
  mapped_job_count INTEGER;
  mapped_status_count INTEGER;
  violation_seen BOOLEAN := FALSE;
  legacy_device_id TEXT;
BEGIN
  SELECT COUNT(*) INTO device_count FROM "PrinterDevice";
  IF device_count <> 2 THEN
    RAISE EXCEPTION 'Expected 2 legacy primary PrinterDevice rows; got %', device_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "PrinterDevice"
    WHERE "status" <> 'DISCOVERY_REQUIRED'
       OR "healthStatus" <> 'UNKNOWN'
       OR "isDefault" IS DISTINCT FROM TRUE
       OR "windowsPrinterName" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Legacy primary device must remain pending discovery with no guessed Windows queue name';
  END IF;

  SELECT COUNT(*) INTO mapped_qr_count
  FROM "PrinterQr"
  WHERE "printerDeviceId" IS NOT NULL;
  IF mapped_qr_count <> 2 THEN
    RAISE EXCEPTION 'Expected both legacy QR rows mapped; got %', mapped_qr_count;
  END IF;

  IF (SELECT "publicCode" FROM "PrinterQr" WHERE "id" = 'qr-a') <> 'legacy-public-token-a' THEN
    RAISE EXCEPTION 'Legacy QR publicCode changed during migration';
  END IF;

  SELECT COUNT(*) INTO mapped_session_count
  FROM "Session"
  WHERE "printerDeviceId" IS NOT NULL;
  IF mapped_session_count <> 2 THEN
    RAISE EXCEPTION 'Expected QR-linked and Machine-fallback sessions mapped; got %', mapped_session_count;
  END IF;

  IF (SELECT "paymentMode" FROM "Session" WHERE "id" = 'session-a') <> 'CASH_AT_COUNTER'
     OR (SELECT "paymentMode" FROM "Session" WHERE "id" = 'session-b') <> 'CASHFREE_ONLINE' THEN
    RAISE EXCEPTION 'Session payment-mode snapshots changed during migration';
  END IF;

  SELECT COUNT(*) INTO mapped_job_count
  FROM "PrintJob"
  WHERE "printerDeviceId" IS NOT NULL;
  IF mapped_job_count <> 2 THEN
    RAISE EXCEPTION 'Expected existing PrintJobs mapped to legacy primary devices; got %', mapped_job_count;
  END IF;

  IF (SELECT "cost" FROM "PrintJob" WHERE "id" = 'job-a') <> 12.50
     OR (SELECT "status" FROM "PrintJob" WHERE "id" = 'job-a') <> 'COMPLETED'
     OR (SELECT "paymentMode" FROM "PrintJob" WHERE "id" = 'job-a') <> 'CASH_AT_COUNTER' THEN
    RAISE EXCEPTION 'Historical PrintJob values changed during migration';
  END IF;

  SELECT COUNT(*) INTO mapped_status_count
  FROM "PrinterStatus"
  WHERE "printerDeviceId" IS NOT NULL;
  IF mapped_status_count <> 2 THEN
    RAISE EXCEPTION 'Expected Machine-level telemetry rows attributed to legacy primary devices; got %', mapped_status_count;
  END IF;

  SELECT "id" INTO legacy_device_id
  FROM "PrinterDevice"
  WHERE "machineId" = 'machine-a' AND "isDefault" = TRUE;

  -- Phase 1 must retain the old active-per-Machine QR invariant. A second
  -- active QR for a different child device is still blocked until Phase 3.
  INSERT INTO "PrinterDevice" (
    "id", "machineId", "displayName", "windowsPrinterName", "status",
    "healthStatus", "isDefault", "createdAt", "updatedAt"
  ) VALUES (
    'device-a2', 'machine-a', 'Second Printer', 'Queue 2', 'ACTIVE',
    'UNKNOWN', FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

  BEGIN
    INSERT INTO "PrinterQr" (
      "id", "publicCode", "label", "status", "machineId", "printerDeviceId",
      "createdAt", "updatedAt"
    ) VALUES (
      'qr-a2', 'new-public-token-a2', 'Second Printer', 'ACTIVE', 'machine-a',
      'device-a2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  EXCEPTION WHEN unique_violation THEN
    violation_seen := TRUE;
  END;

  IF NOT violation_seen THEN
    RAISE EXCEPTION 'Legacy active-per-Machine QR constraint was not retained in Phase 1';
  END IF;

  RAISE NOTICE 'PASS: Phase 1 legacy backfill preserved QR tokens, sessions, jobs, payment snapshots and status rows; no Windows queue names were guessed.';
END
$assert$;

ROLLBACK;
