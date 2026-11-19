-- One ACTIVE legacy Machine QR is retained for old clients.
-- Phase 1 already created "printer_qrs_printer_device_active_unique"; keep that
-- index and add a separate active-per-Machine rule for only legacy (NULL child)
-- QR rows. Do not recreate the per-Device index.
DROP INDEX IF EXISTS "printer_qrs_machine_id_active_unique";

CREATE UNIQUE INDEX "printer_qrs_machine_id_legacy_active_unique"
  ON "PrinterQr"("machineId")
  WHERE "status" = 'ACTIVE'
    AND "machineId" IS NOT NULL
    AND "printerDeviceId" IS NULL;
