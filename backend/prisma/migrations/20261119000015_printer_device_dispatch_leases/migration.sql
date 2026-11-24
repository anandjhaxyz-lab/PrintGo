CREATE TABLE "PrinterDeviceDispatchLease" (
    "printerDeviceId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "jobShortId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PrinterDeviceDispatchLease_pkey" PRIMARY KEY ("printerDeviceId")
);

CREATE UNIQUE INDEX "PrinterDeviceDispatchLease_requestId_key"
    ON "PrinterDeviceDispatchLease"("requestId");

CREATE INDEX "PrinterDeviceDispatchLease_releasedAt_expiresAt_idx"
    ON "PrinterDeviceDispatchLease"("releasedAt", "expiresAt");

CREATE INDEX "PrinterDeviceDispatchLease_jobShortId_idx"
    ON "PrinterDeviceDispatchLease"("jobShortId");

ALTER TABLE "PrinterDeviceDispatchLease"
    ADD CONSTRAINT "PrinterDeviceDispatchLease_printerDeviceId_fkey"
    FOREIGN KEY ("printerDeviceId") REFERENCES "PrinterDevice"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
