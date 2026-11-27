CREATE TABLE "LegacyPrinterQrBinding" (
  "id" TEXT NOT NULL,
  "printerQrId" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "printerDeviceId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "approvedBy" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokedBy" TEXT,
  "revokedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LegacyPrinterQrBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LegacyPrinterQrBinding_printerQrId_fkey" FOREIGN KEY ("printerQrId") REFERENCES "PrinterQr"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LegacyPrinterQrBinding_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LegacyPrinterQrBinding_printerDeviceId_fkey" FOREIGN KEY ("printerDeviceId") REFERENCES "PrinterDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "LegacyPrinterQrBinding_printerQrId_key" ON "LegacyPrinterQrBinding"("printerQrId");
CREATE INDEX "LegacyPrinterQrBinding_machineId_status_idx" ON "LegacyPrinterQrBinding"("machineId", "status");
CREATE INDEX "LegacyPrinterQrBinding_printerDeviceId_status_idx" ON "LegacyPrinterQrBinding"("printerDeviceId", "status");
