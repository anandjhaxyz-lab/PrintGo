-- Persist Agent-discovered Windows queues for explicit Admin review only.
CREATE TABLE "PrinterDiscovery" (
  "id" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "windowsPrinterName" TEXT NOT NULL,
  "queueNameKey" TEXT NOT NULL,
  "driverName" TEXT,
  "portName" TEXT,
  "connectionType" TEXT NOT NULL DEFAULT 'Unknown',
  "printerStatus" TEXT,
  "detectedErrorState" TEXT,
  "workOffline" BOOLEAN,
  "shared" BOOLEAN,
  "network" BOOLEAN,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "reviewStatus" TEXT NOT NULL DEFAULT 'DISCOVERED',
  "approvedPrinterDeviceId" TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrinterDiscovery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrinterDiscovery_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PrinterDiscovery_machineId_queueNameKey_key"
  ON "PrinterDiscovery"("machineId", "queueNameKey");
CREATE INDEX "PrinterDiscovery_machineId_reviewStatus_lastSeenAt_idx"
  ON "PrinterDiscovery"("machineId", "reviewStatus", "lastSeenAt");
CREATE UNIQUE INDEX "PrinterDevice_machineId_windowsPrinterName_key"
  ON "PrinterDevice"("machineId", "windowsPrinterName");
