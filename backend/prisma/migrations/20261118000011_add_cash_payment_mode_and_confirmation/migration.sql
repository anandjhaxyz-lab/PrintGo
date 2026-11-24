-- AlterTable
ALTER TABLE "Machine" ADD COLUMN "paymentMode" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "paymentMode" TEXT;

-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN "paymentMode" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "confirmedBy" TEXT;
ALTER TABLE "Payment" ADD COLUMN "confirmedAt" TIMESTAMP(3);

-- Selective historical backfill for PrintJob ONLY where paymentMode is reliably determined:
-- 1. Cash payments confirmed with cash method
UPDATE "PrintJob" pj
SET "paymentMode" = 'CASH_AT_COUNTER'
FROM "Payment" p
WHERE pj."paymentId" = p."id"
  AND p."paymentMethod" = 'cash'
  AND pj."paymentMode" IS NULL;

-- 2. Demo payments
UPDATE "PrintJob" pj
SET "paymentMode" = 'DEMO_SIMULATION'
FROM "Payment" p
WHERE pj."paymentId" = p."id"
  AND (p."paymentMethod" = 'demo' OR p."paymentGroup" = 'simulated')
  AND pj."paymentMode" IS NULL;

-- 3. Cashfree online payments
UPDATE "PrintJob" pj
SET "paymentMode" = 'CASHFREE_ONLINE'
FROM "Payment" p
WHERE pj."paymentId" = p."id"
  AND (p."gatewayOrderId" LIKE 'order_%' OR p."paymentMethod" IN ('card', 'upi', 'netbanking', 'wallet', 'app'))
  AND pj."paymentMode" IS NULL;
