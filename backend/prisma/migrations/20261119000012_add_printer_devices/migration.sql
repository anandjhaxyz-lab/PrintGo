-- PrintGo Multi-Printer Phase 1: additive PrinterDevice foundation.
-- Safety: keep the legacy active-per-Machine QR index in place until Phase 3
-- updates QR APIs and Admin UI to create one active QR per PrinterDevice.
-- Existing public QR codes, Machine IDs, payment modes and job states are unchanged.

CREATE TABLE "PrinterDevice" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "windowsPrinterName" TEXT,
    "printerModel" TEXT,
    "driverName" TEXT,
    "portName" TEXT,
    "connectionType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DISCOVERY_REQUIRED',
    "healthStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "lastDiscoveredAt" TIMESTAMP(3),
    "lastTelemetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PrinterDevice_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PrinterQr" ADD COLUMN "printerDeviceId" TEXT;
ALTER TABLE "Session" ADD COLUMN "printerDeviceId" TEXT;
ALTER TABLE "PrintJob" ADD COLUMN "printerDeviceId" TEXT;
ALTER TABLE "PrinterStatus" ADD COLUMN "printerDeviceId" TEXT;

-- Create exactly one logical legacy primary device per existing Machine.
-- Do NOT populate windowsPrinterName from Machine.printerModel: model is not
-- a verified Windows spooler queue name. Discovery and Admin approval are required.
INSERT INTO "PrinterDevice" (
    "id",
    "machineId",
    "displayName",
    "windowsPrinterName",
    "printerModel",
    "driverName",
    "portName",
    "connectionType",
    "status",
    "healthStatus",
    "isDefault",
    "sortOrder",
    "approvedAt",
    "approvedBy",
    "lastDiscoveredAt",
    "lastTelemetryAt",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    m."id",
    COALESCE(NULLIF(BTRIM(m."name"), ''), 'Machine') || ' - Primary Printer (pending discovery)',
    NULL,
    m."printerModel",
    NULL,
    NULL,
    m."connectionType",
    'DISCOVERY_REQUIRED',
    'UNKNOWN',
    TRUE,
    0,
    NULL,
    NULL,
    NULL,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Machine" m
WHERE NOT EXISTS (
    SELECT 1
    FROM "PrinterDevice" pd
    WHERE pd."machineId" = m."id"
);

-- Preserve the existing QR identity/publicCode and bind every historical QR
-- to the Machine's legacy primary device where the mapping is unambiguous.
UPDATE "PrinterQr" pq
SET "printerDeviceId" = pd."id"
FROM "PrinterDevice" pd
WHERE pq."machineId" = pd."machineId"
  AND pd."isDefault" = TRUE
  AND pq."printerDeviceId" IS NULL;

-- Prefer the QR record that originally created a Session, then use its
-- Machine's default primary device only when the QR association is absent.
-- Enforce machine match so inconsistent historical QR references cannot map across machines.
UPDATE "Session" s
SET "printerDeviceId" = pq."printerDeviceId"
FROM "PrinterQr" pq
WHERE s."printerQrId" = pq."id"
  AND s."machineId" = pq."machineId"
  AND pq."printerDeviceId" IS NOT NULL
  AND s."printerDeviceId" IS NULL
  AND EXISTS (
      SELECT 1
      FROM "PrinterDevice" pd
      WHERE pd."id" = pq."printerDeviceId"
        AND pd."machineId" = s."machineId"
  );

UPDATE "Session" s
SET "printerDeviceId" = pd."id"
FROM "PrinterDevice" pd
WHERE s."machineId" = pd."machineId"
  AND pd."isDefault" = TRUE
  AND s."printerDeviceId" IS NULL;

-- At this baseline one Machine represents one legacy physical printer queue.
-- Bind old jobs to that logical primary identity. Historical jobs keep all their
-- existing Machine/payment/status values and remain readable by legacy code.
UPDATE "PrintJob" j
SET "printerDeviceId" = pd."id"
FROM "PrinterDevice" pd
WHERE j."machineId" = pd."machineId"
  AND pd."isDefault" = TRUE
  AND j."printerDeviceId" IS NULL;

-- Existing Machine-level telemetry is attributed to the legacy primary device.
UPDATE "PrinterStatus" ps
SET "printerDeviceId" = pd."id"
FROM "PrinterDevice" pd
WHERE ps."machineId" = pd."machineId"
  AND pd."isDefault" = TRUE
  AND ps."printerDeviceId" IS NULL;

-- Foreign keys are optional on historical/legacy records and use SET NULL so
-- deleting a device cannot delete payment, job, QR or session history.
ALTER TABLE "PrinterDevice"
    ADD CONSTRAINT "PrinterDevice_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PrinterQr"
    ADD CONSTRAINT "PrinterQr_printerDeviceId_fkey"
    FOREIGN KEY ("printerDeviceId") REFERENCES "PrinterDevice"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Session"
    ADD CONSTRAINT "Session_printerDeviceId_fkey"
    FOREIGN KEY ("printerDeviceId") REFERENCES "PrinterDevice"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PrintJob"
    ADD CONSTRAINT "PrintJob_printerDeviceId_fkey"
    FOREIGN KEY ("printerDeviceId") REFERENCES "PrinterDevice"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PrinterStatus"
    ADD CONSTRAINT "PrinterStatus_printerDeviceId_fkey"
    FOREIGN KEY ("printerDeviceId") REFERENCES "PrinterDevice"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PrinterDevice_machineId_status_idx"
    ON "PrinterDevice"("machineId", "status");
CREATE INDEX "PrinterDevice_machineId_healthStatus_idx"
    ON "PrinterDevice"("machineId", "healthStatus");
CREATE INDEX "PrinterQr_printerDeviceId_idx"
    ON "PrinterQr"("printerDeviceId");
CREATE INDEX "Session_printerDeviceId_status_idx"
    ON "Session"("printerDeviceId", "status");
CREATE INDEX "PrintJob_printerDeviceId_status_createdAt_idx"
    ON "PrintJob"("printerDeviceId", "status", "createdAt");
CREATE INDEX "PrinterStatus_printerDeviceId_timestamp_idx"
    ON "PrinterStatus"("printerDeviceId", "timestamp");

-- One default legacy device per Machine.
CREATE UNIQUE INDEX "printer_devices_machine_default_unique"
    ON "PrinterDevice"("machineId")
    WHERE "isDefault" = TRUE;

-- Prevent two logical device rows from claiming the same active Windows queue
-- within one Machine; Windows queue names are case-insensitive.
CREATE UNIQUE INDEX "printer_devices_machine_windows_queue_unique"
    ON "PrinterDevice"("machineId", LOWER("windowsPrinterName"))
    WHERE "windowsPrinterName" IS NOT NULL;

-- New per-device active QR uniqueness is prepared here. The old per-Machine
-- partial unique index is intentionally NOT dropped in Phase 1.
CREATE UNIQUE INDEX "printer_qrs_printer_device_active_unique"
    ON "PrinterQr"("printerDeviceId")
    WHERE "status" = 'ACTIVE' AND "printerDeviceId" IS NOT NULL;
