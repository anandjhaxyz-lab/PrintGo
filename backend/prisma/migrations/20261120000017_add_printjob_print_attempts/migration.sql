-- AlterTable: UP-02 Transaction-Wide Attempt Cap & Legacy Fail-Closed Safety
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "authorizedPrintAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "legacyAttemptsUnknown" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PrintJob" ADD COLUMN IF NOT EXISTS "printAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PrintJob" ADD COLUMN IF NOT EXISTS "legacyAttemptsUnknown" BOOLEAN NOT NULL DEFAULT false;

-- Conservative Legacy Backfill:
-- 1. Jobs in COMPLETED or REFUNDED: attempts exhausted; mark printAttempts = 3 to disallow fresh prints.
UPDATE "PrintJob"
SET "printAttempts" = 3
WHERE "status" IN ('COMPLETED', 'REFUNDED');

-- 2. Jobs in PRINTING: in-flight or ambiguous attempt; fail closed: printAttempts = 3, legacyAttemptsUnknown = true.
UPDATE "PrintJob"
SET "printAttempts" = 3, "legacyAttemptsUnknown" = true
WHERE "status" = 'PRINTING';

-- 3. Jobs in FAILED: if PrintHistory exists or unknown dispatch history, fail closed.
UPDATE "PrintJob" pj
SET "printAttempts" = 3, "legacyAttemptsUnknown" = true
WHERE "status" = 'FAILED'
  AND (EXISTS (SELECT 1 FROM "PrintHistory" ph WHERE ph."printJobId" = pj.id) OR pj."createdAt" < NOW());

-- 4. Jobs in WAITING / PENDING_PAYMENT:
-- Only remain 0 attempts if NEVER dispatched (no PrintHistory). If any PrintHistory exists, fail closed.
UPDATE "PrintJob" pj
SET "printAttempts" = 3, "legacyAttemptsUnknown" = true
WHERE "status" IN ('WAITING', 'PENDING_PAYMENT')
  AND EXISTS (SELECT 1 FROM "PrintHistory" ph WHERE ph."printJobId" = pj.id);

-- 5. Synchronize Payment transaction counters from PrintJob counters:
UPDATE "Payment" p
SET "authorizedPrintAttempts" = LEAST(3, COALESCE((
  SELECT SUM("printAttempts") FROM "PrintJob" pj WHERE pj."paymentId" = p.id
), 0)),
"legacyAttemptsUnknown" = COALESCE((
  SELECT bool_or("legacyAttemptsUnknown") FROM "PrintJob" pj WHERE pj."paymentId" = p.id
), false);
