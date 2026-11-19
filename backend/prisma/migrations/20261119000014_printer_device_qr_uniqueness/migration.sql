-- One ACTIVE legacy Machine QR is retained for old clients.
-- Each approved PrinterDevice may independently own one ACTIVE customer QR.
DROP INDEX IF EXISTS "printer_qrs_machine_id_active_unique";

CREATE UNIQUE INDEX "printer_qrs_machine_id_legacy_active_unique"
  ON "PrinterQr"("machineId")
  WHERE "status" = 'ACTIVE'
    AND "machineId" IS NOT NULL
    AND "printerDeviceId" IS NULL;

CREATE UNIQUE INDEX "printer_qrs_printer_device_active_unique"
  ON "PrinterQr"("printerDeviceId")
  WHERE "status" = 'ACTIVE'
    AND "printerDeviceId" IS NOT NULL;
