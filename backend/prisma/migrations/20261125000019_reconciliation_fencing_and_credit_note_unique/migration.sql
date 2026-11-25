-- Pre-migration assertion: Ensure no duplicate non-null refundId exists before applying unique index
DO $$
DECLARE duplicate_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT "refundId"
    FROM "CreditNote"
    WHERE "refundId" IS NOT NULL
    GROUP BY "refundId"
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % duplicate non-null refundId entries exist in CreditNote', duplicate_count;
  END IF;
END $$;

-- Create partial unique index on CreditNote(refundId)
CREATE UNIQUE INDEX "CreditNote_refundId_key" ON "CreditNote"("refundId") WHERE "refundId" IS NOT NULL;

-- AlterTable ReconciliationRecord to add worker fencing and dispatch state columns
ALTER TABLE "ReconciliationRecord"
ADD COLUMN "workerId" TEXT,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "fencingToken" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "dispatchState" TEXT NOT NULL DEFAULT 'MANUAL_REVIEW_REQUIRED';

-- Safe backfill: Promote definitively resolved records or refunds already terminal/settled
UPDATE "ReconciliationRecord" rr
SET "dispatchState" = 'GATEWAY_CONFIRMED'
WHERE rr.resolved = true
   OR EXISTS (
     SELECT 1 FROM "Refund" r
     WHERE r.id = rr."refundId"
       AND r.status IN ('SUCCESS', 'FAILED', 'CANCELLED')
   );

-- Safe backfill: Active processing/pending refunds with unverified gateway state are quarantined to OUTCOME_UNKNOWN (Inquiry Only)
UPDATE "ReconciliationRecord" rr
SET "dispatchState" = 'OUTCOME_UNKNOWN'
WHERE rr.resolved = false
  AND rr."refundId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "Refund" r
    WHERE r.id = rr."refundId"
      AND r.status IN ('PROCESSING', 'PENDING')
  );

-- All other unresolved records remain defaulted to MANUAL_REVIEW_REQUIRED

-- Default for future new records is NOT_DISPATCHED
ALTER TABLE "ReconciliationRecord"
ALTER COLUMN "dispatchState" SET DEFAULT 'NOT_DISPATCHED';

-- Create claim index for high-speed worker polling
CREATE INDEX "ReconciliationRecord_claim_idx" ON "ReconciliationRecord"("status", "resolved", "leaseExpiresAt");
