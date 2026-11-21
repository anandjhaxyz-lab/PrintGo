-- AlterTable: UP-02 Payment Attempt Reservation Ownership
ALTER TABLE "PrintJob" ADD COLUMN IF NOT EXISTS "reservedForRetry" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: ensure all existing rows default to false
UPDATE "PrintJob" SET "reservedForRetry" = false WHERE "reservedForRetry" IS NULL;
