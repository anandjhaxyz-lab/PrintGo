\set ON_ERROR_STOP on

-- Full isolated migration-chain regression test.
-- This creates a representative pre-multi-printer schema in a disposable schema,
-- applies the exact production SQL for migrations 00012-00016, and rolls back.
DROP SCHEMA IF EXISTS multi_printer_full_migration_test CASCADE;
BEGIN;
CREATE SCHEMA multi_printer_full_migration_test;
SET LOCAL search_path TO multi_printer_full_migration_test, public;

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

-- This is the exact pre-existing invariant created by migration 00007.
CREATE UNIQUE INDEX "printer_qrs_machine_id_active_unique"
  ON "PrinterQr"("machineId")
  WHERE "status" = 'ACTIVE' AND "machineId" IS NOT NULL;

CREATE TABLE "Session" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE,
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
  "shortId" TEXT NOT NULL UNIQUE,
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
  ('machine-b', 'Second Shop PC', 'HP LaserJet', 'Network'),
  ('machine-c', 'Third Shop PC', 'Canon imageCLASS', 'USB'),
  ('machine-d', 'Legacy Counter PC', 'Brother HL-L2460DW', 'USB');

INSERT INTO "PrinterQr" ("id", "publicCode", "label", "status", "machineId") VALUES
  ('qr-a', 'legacy-public-token-a', 'Front Desk', 'ACTIVE', 'machine-a'),
  ('qr-b', 'legacy-public-token-b', 'Back Counter', 'ACTIVE', 'machine-b'),
  ('qr-c', 'legacy-public-token-c', 'Third Counter', 'ACTIVE', 'machine-c');

INSERT INTO "Session" ("id", "code", "status", "machineId", "printerQrId", "paymentMode", "expiresAt") VALUES
  ('session-a', 'SESSIONA12345', 'WAITING_FOR_MOBILE', 'machine-a', 'qr-a', 'CASH_AT_COUNTER', CURRENT_TIMESTAMP + INTERVAL '1 hour'),
  ('session-b', 'SESSIONB12345', 'WAITING_FOR_MOBILE', 'machine-b', NULL, 'CASHFREE_ONLINE', CURRENT_TIMESTAMP + INTERVAL '1 hour');

INSERT INTO "PrintJob" ("id", "shortId", "status", "cost", "machineId", "paymentMode") VALUES
  ('job-a', 'JOBA1234', 'COMPLETED', 12.50, 'machine-a', 'CASH_AT_COUNTER'),
  ('job-b', 'JOBB1234', 'COMPLETED', 7.00, 'machine-b', 'CASHFREE_ONLINE'),
  ('job-c', 'JOBC1234', 'COMPLETED', 9.00, 'machine-c', 'CASH_AT_COUNTER');

INSERT INTO "PrinterStatus" ("id", "machineId", "isOnline", "paperStatus", "connectionType") VALUES
  ('status-a', 'machine-a', TRUE, 'OK', 'USB'),
  ('status-b', 'machine-b', FALSE, 'OUT', 'Network');

-- 00012: additive PrinterDevice foundation and legacy backfill.
\ir ../../prisma/migrations/20261119000012_add_printer_devices/migration.sql

DO $assert_phase1$
DECLARE
  device_count INTEGER;
  mapped_qr_count INTEGER;
  mapped_session_count INTEGER;
  mapped_job_count INTEGER;
  mapped_status_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO device_count FROM "PrinterDevice";
  IF device_count <> 4 THEN
    RAISE EXCEPTION '00012: expected 4 legacy primary devices; got %', device_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "PrinterDevice"
    WHERE "status" <> 'DISCOVERY_REQUIRED'
       OR "healthStatus" <> 'UNKNOWN'
       OR "isDefault" IS DISTINCT FROM TRUE
       OR "windowsPrinterName" IS NOT NULL
  ) THEN
    RAISE EXCEPTION '00012: legacy primary devices must be pending discovery with no guessed Windows queue';
  END IF;

  SELECT COUNT(*) INTO mapped_qr_count FROM "PrinterQr" WHERE "printerDeviceId" IS NOT NULL;
  IF mapped_qr_count <> 3 THEN
    RAISE EXCEPTION '00012: expected 3 legacy QR rows mapped; got %', mapped_qr_count;
  END IF;
  IF (SELECT "publicCode" FROM "PrinterQr" WHERE "id" = 'qr-a') <> 'legacy-public-token-a' THEN
    RAISE EXCEPTION '00012: legacy QR publicCode changed';
  END IF;

  SELECT COUNT(*) INTO mapped_session_count FROM "Session" WHERE "printerDeviceId" IS NOT NULL;
  IF mapped_session_count <> 2 THEN
    RAISE EXCEPTION '00012: expected QR-linked and Machine-fallback sessions mapped; got %', mapped_session_count;
  END IF;
  IF (SELECT "paymentMode" FROM "Session" WHERE "id" = 'session-a') <> 'CASH_AT_COUNTER'
     OR (SELECT "paymentMode" FROM "Session" WHERE "id" = 'session-b') <> 'CASHFREE_ONLINE' THEN
    RAISE EXCEPTION '00012: session payment-mode snapshots changed';
  END IF;

  SELECT COUNT(*) INTO mapped_job_count FROM "PrintJob" WHERE "printerDeviceId" IS NOT NULL;
  IF mapped_job_count <> 3 THEN
    RAISE EXCEPTION '00012: expected 3 historical jobs mapped; got %', mapped_job_count;
  END IF;
  IF (SELECT "cost" FROM "PrintJob" WHERE "id" = 'job-a') <> 12.50
     OR (SELECT "status" FROM "PrintJob" WHERE "id" = 'job-a') <> 'COMPLETED'
     OR (SELECT "paymentMode" FROM "PrintJob" WHERE "id" = 'job-a') <> 'CASH_AT_COUNTER' THEN
    RAISE EXCEPTION '00012: historical PrintJob values changed';
  END IF;

  SELECT COUNT(*) INTO mapped_status_count FROM "PrinterStatus" WHERE "printerDeviceId" IS NOT NULL;
  IF mapped_status_count <> 2 THEN
    RAISE EXCEPTION '00012: expected 2 telemetry rows mapped; got %', mapped_status_count;
  END IF;
END
$assert_phase1$;

-- Simulate verified Admin-approved queue discovery before 00016.
-- Machine B remains NULL and Machine C deliberately has a blank queue name.
UPDATE "PrinterDevice"
SET "windowsPrinterName" = 'Epson L6460',
    "status" = 'ACTIVE',
    "approvedAt" = CURRENT_TIMESTAMP
WHERE "machineId" = 'machine-a' AND "isDefault" = TRUE;

UPDATE "PrinterDevice"
SET "windowsPrinterName" = '   ',
    "status" = 'ACTIVE',
    "approvedAt" = CURRENT_TIMESTAMP
WHERE "machineId" = 'machine-c' AND "isDefault" = TRUE;

-- 00013: discovery/approval inventory.
\ir ../../prisma/migrations/20261119000013_printer_discovery_approval/migration.sql

-- The functional lower(queue) index from 00012 must reject case-only duplicates.
INSERT INTO "PrinterDevice" (
  "id", "machineId", "displayName", "windowsPrinterName",
  "status", "healthStatus", "isDefault", "createdAt", "updatedAt"
) VALUES (
  'device-a2', 'machine-a', 'Second Printer', 'HP LaserJet',
  'DISCOVERY_REQUIRED', 'UNKNOWN', FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

DO $assert_queue_uniqueness$
DECLARE violation_seen BOOLEAN := FALSE;
BEGIN
  BEGIN
    INSERT INTO "PrinterDevice" (
      "id", "machineId", "displayName", "windowsPrinterName",
      "status", "healthStatus", "isDefault", "createdAt", "updatedAt"
    ) VALUES (
      'device-a-duplicate', 'machine-a', 'Duplicate Queue', 'epson l6460',
      'DISCOVERY_REQUIRED', 'UNKNOWN', FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  EXCEPTION WHEN unique_violation THEN
    violation_seen := TRUE;
  END;
  IF NOT violation_seen THEN
    RAISE EXCEPTION '00012/00013: case-insensitive duplicate Windows queue was accepted';
  END IF;
END
$assert_queue_uniqueness$;

-- 00014: transition from one ACTIVE QR per Machine to one per device,
-- while retaining a separate one-ACTIVE-legacy-QR-per-Machine rule.
\ir ../../prisma/migrations/20261119000014_printer_device_qr_uniqueness/migration.sql

DO $assert_index_transition$
DECLARE
  violation_seen BOOLEAN := FALSE;
BEGIN
  IF to_regclass('printer_qrs_machine_id_active_unique') IS NOT NULL THEN
    RAISE EXCEPTION '00014: old active-per-Machine index was not dropped';
  END IF;
  IF to_regclass('printer_qrs_printer_device_active_unique') IS NULL
     OR to_regclass('printer_qrs_machine_id_legacy_active_unique') IS NULL THEN
    RAISE EXCEPTION '00014: new partial indexes are missing';
  END IF;

  -- Non-active historical QR rows do not occupy the active slot.
  INSERT INTO "PrinterQr" (
    "id", "publicCode", "label", "status", "machineId", "printerDeviceId",
    "createdAt", "updatedAt"
  ) VALUES
    ('qr-a2-revoked', 'revoked-public-token-a2', 'Old QR', 'REVOKED', 'machine-a', 'device-a2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('qr-a2-replaced', 'replaced-public-token-a2', 'Replaced QR', 'REPLACED', 'machine-a', 'device-a2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

  -- Same Machine as qr-a, but a different child device: must be allowed.
  INSERT INTO "PrinterQr" (
    "id", "publicCode", "label", "status", "machineId", "printerDeviceId",
    "createdAt", "updatedAt"
  ) VALUES (
    'qr-a2-active', 'active-public-token-a2', 'Second Printer', 'ACTIVE',
    'machine-a', 'device-a2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

  BEGIN
    INSERT INTO "PrinterQr" (
      "id", "publicCode", "label", "status", "machineId", "printerDeviceId",
      "createdAt", "updatedAt"
    ) VALUES (
      'qr-a2-active-duplicate', 'duplicate-active-public-token-a2', 'Duplicate', 'ACTIVE',
      'machine-a', 'device-a2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  EXCEPTION WHEN unique_violation THEN
    violation_seen := TRUE;
  END;
  IF NOT violation_seen THEN
    RAISE EXCEPTION '00014: second ACTIVE QR for the same PrinterDevice was accepted';
  END IF;

  -- Machine D has both a legacy unbound QR and a device-bound QR.
  -- Those separate identity types are allowed to coexist.
  INSERT INTO "PrinterQr" (
    "id", "publicCode", "label", "status", "machineId", "printerDeviceId",
    "createdAt", "updatedAt"
  ) VALUES (
    'qr-d-legacy', 'legacy-unbound-token-d', 'Legacy Counter', 'ACTIVE',
    'machine-d', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

  INSERT INTO "PrinterDevice" (
    "id", "machineId", "displayName", "windowsPrinterName",
    "status", "healthStatus", "isDefault", "createdAt", "updatedAt"
  ) VALUES (
    'device-d2', 'machine-d', 'Additional Device', 'Brother Secondary Queue',
    'DISCOVERY_REQUIRED', 'UNKNOWN', FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

  INSERT INTO "PrinterQr" (
    "id", "publicCode", "label", "status", "machineId", "printerDeviceId",
    "createdAt", "updatedAt"
  ) VALUES (
    'qr-d-device', 'device-bound-token-d', 'Additional Device', 'ACTIVE',
    'machine-d', 'device-d2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

  violation_seen := FALSE;
  BEGIN
    INSERT INTO "PrinterQr" (
      "id", "publicCode", "label", "status", "machineId", "printerDeviceId",
      "createdAt", "updatedAt"
    ) VALUES (
      'qr-d-legacy-duplicate', 'legacy-unbound-token-d2', 'Duplicate Legacy', 'ACTIVE',
      'machine-d', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  EXCEPTION WHEN unique_violation THEN
    violation_seen := TRUE;
  END;
  IF NOT violation_seen THEN
    RAISE EXCEPTION '00014: second ACTIVE legacy NULL-device QR for one Machine was accepted';
  END IF;
END
$assert_index_transition$;

-- 00015: one current dispatch lease per PrinterDevice, and globally unique requestId.
\ir ../../prisma/migrations/20261119000015_printer_device_dispatch_leases/migration.sql

DO $assert_lease_constraints$
DECLARE
  device_slot_violation BOOLEAN := FALSE;
  request_id_violation BOOLEAN := FALSE;
BEGIN
  INSERT INTO "PrinterDeviceDispatchLease" (
    "printerDeviceId", "requestId", "jobShortId", "expiresAt", "createdAt", "updatedAt"
  ) VALUES (
    'device-a2', 'request-unique-a2', 'JOBA1234',
    CURRENT_TIMESTAMP + INTERVAL '2 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );

  BEGIN
    INSERT INTO "PrinterDeviceDispatchLease" (
      "printerDeviceId", "requestId", "jobShortId", "expiresAt", "createdAt", "updatedAt"
    ) VALUES (
      'device-a2', 'request-other-a2', 'JOBA1234',
      CURRENT_TIMESTAMP + INTERVAL '2 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  EXCEPTION WHEN unique_violation THEN
    device_slot_violation := TRUE;
  END;
  IF NOT device_slot_violation THEN
    RAISE EXCEPTION '00015: two lease rows for one PrinterDevice were accepted';
  END IF;

  BEGIN
    INSERT INTO "PrinterDeviceDispatchLease" (
      "printerDeviceId", "requestId", "jobShortId", "expiresAt", "createdAt", "updatedAt"
    ) VALUES (
      'device-d2', 'request-unique-a2', 'JOBB1234',
      CURRENT_TIMESTAMP + INTERVAL '2 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  EXCEPTION WHEN unique_violation THEN
    request_id_violation := TRUE;
  END;
  IF NOT request_id_violation THEN
    RAISE EXCEPTION '00015: duplicate requestId across PrinterDevices was accepted';
  END IF;
END
$assert_lease_constraints$;

-- 00016: snapshot only verified, nonblank device queue mappings.
\ir ../../prisma/migrations/20261119000016_print_job_queue_snapshot/migration.sql

DO $assert_queue_snapshot$
BEGIN
  IF (SELECT "printerWindowsQueueName" FROM "PrintJob" WHERE "id" = 'job-a') IS DISTINCT FROM 'Epson L6460' THEN
    RAISE EXCEPTION '00016: known queue snapshot was not backfilled';
  END IF;

  IF (SELECT "printerWindowsQueueName" FROM "PrintJob" WHERE "id" = 'job-b') IS NOT NULL THEN
    RAISE EXCEPTION '00016: NULL device queue must not create a snapshot';
  END IF;

  IF (SELECT "printerWindowsQueueName" FROM "PrintJob" WHERE "id" = 'job-c') IS NOT NULL THEN
    RAISE EXCEPTION '00016: blank device queue must not create a snapshot';
  END IF;

  -- A later device remap must not rewrite the job's captured queue identity.
  UPDATE "PrinterDevice"
  SET "windowsPrinterName" = 'Epson L6460 - Remapped'
  WHERE "machineId" = 'machine-a' AND "isDefault" = TRUE;

  IF (SELECT "printerWindowsQueueName" FROM "PrintJob" WHERE "id" = 'job-a') <> 'Epson L6460' THEN
    RAISE EXCEPTION '00016: changing the device mapping rewrote the historical PrintJob queue snapshot';
  END IF;

  IF (SELECT "status" FROM "PrintJob" WHERE "id" = 'job-a') IS DISTINCT FROM 'COMPLETED'
     OR (SELECT "cost" FROM "PrintJob" WHERE "id" = 'job-a') IS DISTINCT FROM 12.50
     OR (SELECT "paymentMode" FROM "PrintJob" WHERE "id" = 'job-a') IS DISTINCT FROM 'CASH_AT_COUNTER' THEN
    RAISE EXCEPTION 'Full migration chain changed historical PrintJob payment/status/cost data';
  END IF;
END
$assert_queue_snapshot$;

DO $assert_complete_chain$ BEGIN
  RAISE NOTICE 'PASS: full 00012-00016 migration chain, QR uniqueness transition, lease indexes, legacy data preservation, and queue snapshot backfill.';
END
$assert_complete_chain$;
ROLLBACK;
