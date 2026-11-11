-- Create partial unique index on PrinterQr(machineId) for ACTIVE records
-- Enforces that at most one ACTIVE QR code can exist per machineId (excluding NULL machineId)
CREATE UNIQUE INDEX "printer_qrs_machine_id_active_unique"
ON "PrinterQr"("machineId")
WHERE "status" = 'ACTIVE' AND "machineId" IS NOT NULL;
