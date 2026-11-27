BEGIN;

-- Correct databases where migration 17 was previously applied with CASCADE
-- on PrinterQr and Machine. Rebuild all three foreign keys to match Prisma.
ALTER TABLE "LegacyPrinterQrBinding"
  DROP CONSTRAINT IF EXISTS "LegacyPrinterQrBinding_printerQrId_fkey",
  DROP CONSTRAINT IF EXISTS "LegacyPrinterQrBinding_machineId_fkey",
  DROP CONSTRAINT IF EXISTS "LegacyPrinterQrBinding_printerDeviceId_fkey";

ALTER TABLE "LegacyPrinterQrBinding"
  ADD CONSTRAINT "LegacyPrinterQrBinding_printerQrId_fkey"
    FOREIGN KEY ("printerQrId") REFERENCES "PrinterQr"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LegacyPrinterQrBinding_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "LegacyPrinterQrBinding_printerDeviceId_fkey"
    FOREIGN KEY ("printerDeviceId") REFERENCES "PrinterDevice"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
