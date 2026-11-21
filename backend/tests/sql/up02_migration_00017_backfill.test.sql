\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF current_database() <> 'printgo_disposable_target' THEN
    RAISE EXCEPTION 'SAFETY CHECK FAILED: Refusing to execute migration test against database "%". Script can only run against "printgo_disposable_target".', current_database();
  END IF;
END $$;

-- Isolated pre-migration schema for migration 00017 backfill verification
DROP SCHEMA IF EXISTS migration_00017_test CASCADE;
CREATE SCHEMA migration_00017_test;
SET LOCAL search_path TO migration_00017_test, public;

-- 1. Create pre-migration tables matching schema BEFORE migration 00017
CREATE TABLE "Payment" (
  "id" TEXT PRIMARY KEY,
  "amount" DOUBLE PRECISION NOT NULL,
  "status" TEXT NOT NULL,
  "paymentMode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "PrintJob" (
  "id" TEXT PRIMARY KEY,
  "shortId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "cost" DOUBLE PRECISION NOT NULL,
  "paymentId" TEXT,
  "machineId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "PrintHistory" (
  "id" TEXT PRIMARY KEY,
  "printJobId" TEXT NOT NULL,
  "success" BOOLEAN NOT NULL,
  "errorDetails" TEXT,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Seed representative legacy pre-migration records
-- Payments
INSERT INTO "Payment" ("id", "amount", "status", "paymentMode") VALUES
  ('pay_completed', 20.0, 'SUCCESS', 'CASHFREE_ONLINE'),
  ('pay_refunded', 15.0, 'REFUNDED', 'CASHFREE_ONLINE'),
  ('pay_printing', 25.0, 'SUCCESS', 'CASHFREE_ONLINE'),
  ('pay_failed_with_hist', 10.0, 'SUCCESS', 'CASHFREE_ONLINE'),
  ('pay_failed_no_hist', 10.0, 'SUCCESS', 'CASHFREE_ONLINE'),
  ('pay_waiting_with_hist', 15.0, 'SUCCESS', 'CASHFREE_ONLINE'),
  ('pay_waiting_no_hist', 15.0, 'SUCCESS', 'CASHFREE_ONLINE'),
  ('pay_pending_with_hist', 10.0, 'PENDING', 'CASHFREE_ONLINE'),
  ('pay_pending_no_hist', 10.0, 'PENDING', 'CASHFREE_ONLINE'),
  ('pay_multi_shared', 50.0, 'SUCCESS', 'CASHFREE_ONLINE');

-- PrintJobs
-- 2a. COMPLETED
INSERT INTO "PrintJob" ("id", "shortId", "status", "cost", "paymentId", "createdAt") VALUES
  ('job_completed', 'j_comp', 'COMPLETED', 20.0, 'pay_completed', NOW() - INTERVAL '2 days');

-- 2b. REFUNDED
INSERT INTO "PrintJob" ("id", "shortId", "status", "cost", "paymentId", "createdAt") VALUES
  ('job_refunded', 'j_ref', 'REFUNDED', 15.0, 'pay_refunded', NOW() - INTERVAL '2 days');

-- 2c. PRINTING (ambiguous in-flight)
INSERT INTO "PrintJob" ("id", "shortId", "status", "cost", "paymentId", "createdAt") VALUES
  ('job_printing', 'j_prn', 'PRINTING', 25.0, 'pay_printing', NOW() - INTERVAL '1 day');

-- 2d. FAILED with PrintHistory
INSERT INTO "PrintJob" ("id", "shortId", "status", "cost", "paymentId", "createdAt") VALUES
  ('job_failed_hist', 'j_f_hist', 'FAILED', 10.0, 'pay_failed_with_hist', NOW() - INTERVAL '1 day');
INSERT INTO "PrintHistory" ("id", "printJobId", "success", "errorDetails") VALUES
  ('hist_failed_1', 'job_failed_hist', false, 'Paper jam reported by hardware');

-- 2e. FAILED without PrintHistory (past createdAt)
-- NOTE: In migration 00017, legacy FAILED rows are conservatively exhausted (printAttempts=3, legacyAttemptsUnknown=true)
-- due to pj."createdAt" < NOW() to ensure unknown past physical attempts fail closed.
INSERT INTO "PrintJob" ("id", "shortId", "status", "cost", "paymentId", "createdAt") VALUES
  ('job_failed_no_hist', 'j_f_nohist', 'FAILED', 10.0, 'pay_failed_no_hist', NOW() - INTERVAL '1 hour');

-- 2f. WAITING with PrintHistory (was dispatched previously, now waiting)
INSERT INTO "PrintJob" ("id", "shortId", "status", "cost", "paymentId", "createdAt") VALUES
  ('job_waiting_hist', 'j_w_hist', 'WAITING', 15.0, 'pay_waiting_with_hist', NOW() - INTERVAL '1 day');
INSERT INTO "PrintHistory" ("id", "printJobId", "success", "errorDetails") VALUES
  ('hist_waiting_1', 'job_waiting_hist', false, 'Network disconnect during spool');

-- 2g. WAITING without PrintHistory (fresh, never dispatched)
INSERT INTO "PrintJob" ("id", "shortId", "status", "cost", "paymentId", "createdAt") VALUES
  ('job_waiting_no_hist', 'j_w_nohist', 'WAITING', 15.0, 'pay_waiting_no_hist', NOW());

-- 2h. PENDING_PAYMENT with PrintHistory
INSERT INTO "PrintJob" ("id", "shortId", "status", "cost", "paymentId", "createdAt") VALUES
  ('job_pending_hist', 'j_p_hist', 'PENDING_PAYMENT', 10.0, 'pay_pending_with_hist', NOW() - INTERVAL '1 day');
INSERT INTO "PrintHistory" ("id", "printJobId", "success", "errorDetails") VALUES
  ('hist_pending_1', 'job_pending_hist', false, 'Old attempt before reset');

-- 2i. PENDING_PAYMENT without PrintHistory
INSERT INTO "PrintJob" ("id", "shortId", "status", "cost", "paymentId", "createdAt") VALUES
  ('job_pending_no_hist', 'j_p_nohist', 'PENDING_PAYMENT', 10.0, 'pay_pending_no_hist', NOW());

-- 2j. Multiple PrintJobs sharing one Payment (3 sibling jobs)
INSERT INTO "PrintJob" ("id", "shortId", "status", "cost", "paymentId", "createdAt") VALUES
  ('job_shared_1', 'j_sh_1', 'COMPLETED', 20.0, 'pay_multi_shared', NOW() - INTERVAL '3 days'),
  ('job_shared_2', 'j_sh_2', 'FAILED', 15.0, 'pay_multi_shared', NOW() - INTERVAL '2 days'),
  ('job_shared_3', 'j_sh_3', 'WAITING', 15.0, 'pay_multi_shared', NOW());

-- 3. Apply the exact migration SQL steps from 20261120000017_add_printjob_print_attempts
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "authorizedPrintAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "legacyAttemptsUnknown" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PrintJob" ADD COLUMN IF NOT EXISTS "printAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PrintJob" ADD COLUMN IF NOT EXISTS "legacyAttemptsUnknown" BOOLEAN NOT NULL DEFAULT false;

-- Apply the reservedForRetry migration (add_reserved_for_retry)
ALTER TABLE "PrintJob" ADD COLUMN IF NOT EXISTS "reservedForRetry" BOOLEAN NOT NULL DEFAULT false;

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

-- 4. Execute assertions verifying all backfill outcomes
DO $assert$
DECLARE
  v_attempts INTEGER;
  v_unknown BOOLEAN;
  v_pay_attempts INTEGER;
  v_pay_unknown BOOLEAN;
BEGIN
  -- Assert 1: COMPLETED -> printAttempts = 3, legacyAttemptsUnknown = false
  SELECT "printAttempts", "legacyAttemptsUnknown" INTO v_attempts, v_unknown
  FROM "PrintJob" WHERE "id" = 'job_completed';
  IF v_attempts <> 3 OR v_unknown <> false THEN
    RAISE EXCEPTION 'COMPLETED job failed assertion: expected (3, false), got (%, %)', v_attempts, v_unknown;
  END IF;

  -- Assert 2: REFUNDED -> printAttempts = 3, legacyAttemptsUnknown = false
  SELECT "printAttempts", "legacyAttemptsUnknown" INTO v_attempts, v_unknown
  FROM "PrintJob" WHERE "id" = 'job_refunded';
  IF v_attempts <> 3 OR v_unknown <> false THEN
    RAISE EXCEPTION 'REFUNDED job failed assertion: expected (3, false), got (%, %)', v_attempts, v_unknown;
  END IF;

  -- Assert 3: PRINTING -> printAttempts = 3, legacyAttemptsUnknown = true
  SELECT "printAttempts", "legacyAttemptsUnknown" INTO v_attempts, v_unknown
  FROM "PrintJob" WHERE "id" = 'job_printing';
  IF v_attempts <> 3 OR v_unknown <> true THEN
    RAISE EXCEPTION 'PRINTING job failed assertion: expected (3, true), got (%, %)', v_attempts, v_unknown;
  END IF;

  -- Assert 4: FAILED with PrintHistory -> printAttempts = 3, legacyAttemptsUnknown = true
  SELECT "printAttempts", "legacyAttemptsUnknown" INTO v_attempts, v_unknown
  FROM "PrintJob" WHERE "id" = 'job_failed_hist';
  IF v_attempts <> 3 OR v_unknown <> true THEN
    RAISE EXCEPTION 'FAILED with hist failed assertion: expected (3, true), got (%, %)', v_attempts, v_unknown;
  END IF;

  -- Assert 5: FAILED without PrintHistory (past createdAt) -> printAttempts = 3, legacyAttemptsUnknown = true
  SELECT "printAttempts", "legacyAttemptsUnknown" INTO v_attempts, v_unknown
  FROM "PrintJob" WHERE "id" = 'job_failed_no_hist';
  IF v_attempts <> 3 OR v_unknown <> true THEN
    RAISE EXCEPTION 'FAILED without hist failed assertion: expected (3, true), got (%, %)', v_attempts, v_unknown;
  END IF;

  -- Assert 6: WAITING with PrintHistory -> printAttempts = 3, legacyAttemptsUnknown = true
  SELECT "printAttempts", "legacyAttemptsUnknown" INTO v_attempts, v_unknown
  FROM "PrintJob" WHERE "id" = 'job_waiting_hist';
  IF v_attempts <> 3 OR v_unknown <> true THEN
    RAISE EXCEPTION 'WAITING with hist failed assertion: expected (3, true), got (%, %)', v_attempts, v_unknown;
  END IF;

  -- Assert 7: WAITING without PrintHistory -> printAttempts = 0, legacyAttemptsUnknown = false
  SELECT "printAttempts", "legacyAttemptsUnknown" INTO v_attempts, v_unknown
  FROM "PrintJob" WHERE "id" = 'job_waiting_no_hist';
  IF v_attempts <> 0 OR v_unknown <> false THEN
    RAISE EXCEPTION 'WAITING without hist failed assertion: expected (0, false), got (%, %)', v_attempts, v_unknown;
  END IF;

  -- Assert 8: PENDING_PAYMENT with PrintHistory -> printAttempts = 3, legacyAttemptsUnknown = true
  SELECT "printAttempts", "legacyAttemptsUnknown" INTO v_attempts, v_unknown
  FROM "PrintJob" WHERE "id" = 'job_pending_hist';
  IF v_attempts <> 3 OR v_unknown <> true THEN
    RAISE EXCEPTION 'PENDING_PAYMENT with hist failed assertion: expected (3, true), got (%, %)', v_attempts, v_unknown;
  END IF;

  -- Assert 9: PENDING_PAYMENT without PrintHistory -> printAttempts = 0, legacyAttemptsUnknown = false
  SELECT "printAttempts", "legacyAttemptsUnknown" INTO v_attempts, v_unknown
  FROM "PrintJob" WHERE "id" = 'job_pending_no_hist';
  IF v_attempts <> 0 OR v_unknown <> false THEN
    RAISE EXCEPTION 'PENDING_PAYMENT without hist failed assertion: expected (0, false), got (%, %)', v_attempts, v_unknown;
  END IF;

  -- Assert 10: Multi-job shared payment: LEAST(3, sum) cap and legacyAttemptsUnknown aggregation
  SELECT "authorizedPrintAttempts", "legacyAttemptsUnknown" INTO v_pay_attempts, v_pay_unknown
  FROM "Payment" WHERE "id" = 'pay_multi_shared';
  -- job_shared_1 is COMPLETED (3), job_shared_2 is FAILED (3), job_shared_3 is WAITING (0).
  -- Raw sum = 6, but LEAST(3, 6) must strictly cap authorizedPrintAttempts at 3.
  -- legacyAttemptsUnknown = true because job_shared_2 has legacyAttemptsUnknown = true.
  IF v_pay_attempts <> 3 OR v_pay_unknown <> true THEN
    RAISE EXCEPTION 'Multi shared payment failed assertion: expected (3, true), got (%, %)', v_pay_attempts, v_pay_unknown;
  END IF;

  -- Assert 11: Global invariant: No payment has authorizedPrintAttempts > 3
  IF EXISTS (SELECT 1 FROM "Payment" WHERE "authorizedPrintAttempts" > 3) THEN
    RAISE EXCEPTION 'CRITICAL INVARIANT VIOLATION: Payment found with authorizedPrintAttempts > 3';
  END IF;

  -- Assert 12: reservedForRetry column exists and defaults to false for all pre-existing jobs
  -- Validates add_reserved_for_retry migration backward-safety:
  -- all pre-existing PrintJob rows must receive reservedForRetry = false automatically.
  IF EXISTS (SELECT 1 FROM "PrintJob" WHERE "reservedForRetry" IS NULL) THEN
    RAISE EXCEPTION 'MIGRATION SAFETY FAILURE: reservedForRetry column has NULL rows — DEFAULT false was not applied retroactively';
  END IF;
  IF EXISTS (SELECT 1 FROM "PrintJob" WHERE "reservedForRetry" = true) THEN
    RAISE EXCEPTION 'MIGRATION SAFETY FAILURE: reservedForRetry = true found on legacy PrintJob rows — only admin retry transaction should set this flag';
  END IF;

  RAISE NOTICE 'PASS: UP-02 Migration 00017 Backfill + reservedForRetry migration verified across all representative states.';
END
$assert$;

ROLLBACK;
