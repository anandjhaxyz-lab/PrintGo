-- Preserve the physical Windows queue chosen when each device-bound job was created.
-- PrinterDevice.windowsPrinterName remains mutable for Admin remapping; reports for an
-- existing PrintJob must continue to validate against its immutable queue snapshot.
ALTER TABLE "PrintJob"
    ADD COLUMN "printerWindowsQueueName" TEXT;
