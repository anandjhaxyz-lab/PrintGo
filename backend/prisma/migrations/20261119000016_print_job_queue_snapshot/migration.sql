-- Preserve the physical Windows queue chosen when each device-bound job was created.
-- PrinterDevice.windowsPrinterName remains mutable for Admin remapping; reports for an
-- existing PrintJob must continue to validate against its immutable queue snapshot.
ALTER TABLE "PrintJob"
    ADD COLUMN "printerWindowsQueueName" TEXT;

-- Existing device-bound jobs were historically dispatched using the current
-- PrinterDevice queue name. Capture that mapping once at rollout so in-flight
-- and historic records retain the same report identity. Future remaps never
-- rewrite this PrintJob snapshot.
UPDATE "PrintJob" j
SET "printerWindowsQueueName" = pd."windowsPrinterName"
FROM "PrinterDevice" pd
WHERE j."printerDeviceId" = pd."id"
  AND j."printerWindowsQueueName" IS NULL
  AND pd."windowsPrinterName" IS NOT NULL
  AND BTRIM(pd."windowsPrinterName") <> '';
