BEGIN;

DO $$
DECLARE
  v_db_name TEXT := current_database();
  v_required_constraints TEXT[] := ARRAY[
    'LegacyPrinterQrBinding_printerQrId_fkey',
    'LegacyPrinterQrBinding_machineId_fkey',
    'LegacyPrinterQrBinding_printerDeviceId_fkey'
  ];
  v_constraint TEXT;
  v_delete_action "char";
BEGIN
  IF v_db_name <> 'printgo_disposable_target' THEN
    RAISE EXCEPTION 'SAFETY CHECK FAILED: refusing legacy QR migration contract test against database "%"', v_db_name;
  END IF;

  FOREACH v_constraint IN ARRAY v_required_constraints LOOP
    SELECT c.confdeltype INTO v_delete_action
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'LegacyPrinterQrBinding'
      AND c.conname = v_constraint
      AND c.contype = 'f';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Missing expected foreign key constraint: %', v_constraint;
    END IF;
    IF v_delete_action <> 'r' THEN
      RAISE EXCEPTION 'Expected ON DELETE RESTRICT for %, got action code %', v_constraint, v_delete_action;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'LegacyPrinterQrBinding'
      AND indexname = 'LegacyPrinterQrBinding_printerQrId_key'
      AND indexdef ILIKE '%UNIQUE%'
  ) THEN
    RAISE EXCEPTION 'Missing unique index enforcing one binding per PrinterQr';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'LegacyPrinterQrBinding'
      AND column_name = 'status'
      AND column_default LIKE '%PENDING%'
  ) THEN
    RAISE EXCEPTION 'LegacyPrinterQrBinding.status must default to PENDING';
  END IF;
END $$;

ROLLBACK;
