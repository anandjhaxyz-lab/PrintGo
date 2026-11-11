-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "printerQrId" TEXT;

-- CreateTable
CREATE TABLE "PrinterQr" (
    "id" TEXT NOT NULL,
    "publicCode" TEXT NOT NULL,
    "label" TEXT DEFAULT 'Front Desk Counter',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "machineId" TEXT,
    "generatedBy" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrinterQr_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrinterQr_publicCode_key" ON "PrinterQr"("publicCode");

-- CreateIndex
CREATE INDEX "PrinterQr_publicCode_idx" ON "PrinterQr"("publicCode");

-- CreateIndex
CREATE INDEX "PrinterQr_machineId_idx" ON "PrinterQr"("machineId");

-- CreateIndex
CREATE INDEX "PrinterQr_status_idx" ON "PrinterQr"("status");

-- CreateIndex
CREATE INDEX "Session_printerQrId_idx" ON "Session"("printerQrId");

-- AddForeignKey
ALTER TABLE "PrinterQr" ADD CONSTRAINT "PrinterQr_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_printerQrId_fkey" FOREIGN KEY ("printerQrId") REFERENCES "PrinterQr"("id") ON DELETE SET NULL ON UPDATE CASCADE;

