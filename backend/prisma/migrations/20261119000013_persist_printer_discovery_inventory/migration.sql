-- PrintGo Multi-Printer Phase 3A: persistent queue discovery inventory.
-- Inventory is observational only. It MUST NOT create, bind, approve, activate,
-- or mutate PrinterDevice records. Admin actions perform binding and approval.

CREATE TABLE "PrinterDiscovery" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "windowsPrinterName" TEXT NOT NULL,
    "queueNameKey" TEXT NOT NULL,
    "driverName" TEXT,
    "portName" TEXT,
    "connectionType" TEXT,
    "printerStatus" TEXT,
    "detectedErrorState" TEXT,
    "workOffline" BOOLEAN,
    "shared" BOOLEAN,
    "network" BOOLEAN,
    "isDefault" BOOLEAN,
    "isPresent" BOOLEAN NOT NULL DEFAULT TRUE,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printerDeviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PrinterDiscovery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PrinterDiscovery"
    ADD CONSTRAINT "PrinterDiscovery_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PrinterDiscovery"
    ADD CONSTRAINT "PrinterDiscovery_printerDeviceId_fkey"
    FOREIGN KEY ("printerDeviceId") REFERENCES "PrinterDevice"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "PrinterDiscovery_machineId_queueNameKey_key"
    ON "PrinterDiscovery"("machineId", "queueNameKey");

CREATE UNIQUE INDEX "PrinterDiscovery_printerDeviceId_key"
    ON "PrinterDiscovery"("printerDeviceId");

CREATE INDEX "PrinterDiscovery_machineId_isPresent_lastSeenAt_idx"
    ON "PrinterDiscovery"("machineId", "isPresent", "lastSeenAt");
