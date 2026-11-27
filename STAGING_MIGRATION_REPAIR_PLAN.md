# PR #24 staging migration discrepancy â€” isolated repair plan

Date: 2026-11-28
Workspace: D:\PrintGo-PR24-MigrationRepairPlan
Branch: fix/dedicated-printer-status-device-scope
Base commit: e1b9b84463e35be8b073ce3b362705877484f95f

## Confirmed staging evidence (read-only)

- Render staging backend: printgo-backend-staging
- Backend branch: fix/dedicated-printer-status-device-scope
- Backend auto-deploy: disabled
- Backend's currently live commit at inspection: b93eb0ef714745f0b693c16104710d55cd7b8f0a
- Render staging database: printgo-db-staging / database printgo_staging
- Migration 20261127000017_legacy_printer_qr_bindings is recorded as finished.
- Its recorded Prisma checksum is 37911e2face92a30cd436c0d3c992d600edf8bb37e06337998d3dcaa9b1448f8.
- That checksum exactly matches the historical migration file at commit adcb6168, which had CASCADE on PrinterQr and Machine and RESTRICT on PrinterDevice.
- The merged migration file at commit e1b9b844 has RESTRICT on all three foreign keys.
- Live staging catalog confirms CASCADE on PrinterQr and Machine and RESTRICT on PrinterDevice.
- No LegacyPrinterQrBinding rows currently exist in staging.
- This proves the migration file was changed after staging had applied its earlier version. Editing migration 17 again or rerunning it is not the safe repair.

## Isolated proposed correction

New forward migration:
backend/prisma/migrations/20261128000018_legacy_printer_qr_binding_restrict_delete_actions/migration.sql

It transactionally drops and recreates the three named foreign keys with ON DELETE RESTRICT. It does not update or delete application rows, QR tokens, sessions, jobs, or mappings. It leaves migration 17 and its checksum history intact.

Static regression coverage was added to:
backend/tests/legacyQrMigration/migrationContract.test.js

It asserts the follow-up migration drops/recreates all three named constraints, uses RESTRICT, is transaction-wrapped, and contains no row update/delete statements. Existing disposable PostgreSQL SQL regression coverage still checks all three catalog actions and database identity.

## Verification completed

- npm ci completed in this isolated clone.
- Jest migrationContract.test.js: 1 suite, 9 tests passed.
- git diff --check: passed.
- No commit or push.
- No Render deploy, staging/production write, database migration, QR binding, Agent restart, payment change, or physical print.
- npm reported 34 dependency audit findings (16 moderate, 17 high, 1 critical); no npm audit fix was run.

## Required validation before staging deployment

1. Run a full disposable PostgreSQL rehearsal from a clean database using migrations 1â€“18.
2. Run an upgrade-path rehearsal: apply historical migration 17 as it existed at adcb6168, insert representative binding rows, then apply migration 18.
3. Assert all three foreign keys report confdeltype='r' after migration 18.
4. Assert binding row count and IDs are unchanged; attempts to delete referenced PrinterQr, Machine, and PrinterDevice rows are rejected.
5. Run the full relevant Legacy QR Jest suite and CI SQL migration contract.
6. Review the diff and obtain explicit authorization before commit/push or staging deployment.

## Staging rollout (not authorized/performed)

- Take/verify a restorable staging database backup or snapshot.
- Deploy the reviewed branch to printgo-backend-staging only after separate explicit authorization. Its preDeployCommand runs prisma migrate deploy, so deployment also applies pending migrations.
- Verify migration 18 is recorded finished, all three constraints are RESTRICT, binding row count is unchanged, and staging health checks pass.
- Do not touch production until separately authorized.

## Rollback posture

Do not edit or delete migration history. If migration 18 fails, inspect Prisma migration state and database catalog before any repair. If a successfully applied migration must be reversed, use a separately reviewed forward migration to restore the previous actions; do not mutate migration 17 or manually rewrite _prisma_migrations.

## Disposable PostgreSQL runtime rehearsal (2026-11-28)

Executed on a newly initialized local PostgreSQL 16.16 cluster bound only to 127.0.0.1:55432. No Render staging or production database was used.

- Fresh-install path: created an empty `printgo_fresh` database and ran `prisma migrate deploy`; all 19 migrations, including migrations 17 and 18, applied successfully.
- Upgrade path: created `printgo_upgrade`, applied migrations 1â€“16, then applied the historical migration 17 SQL from commit `adcb6168` (the version with CASCADE on `PrinterQr` and `Machine`, RESTRICT on `PrinterDevice`). Inserted one disposable Machine, PrinterDevice, PrinterQr and LegacyPrinterQrBinding row; applied migration 18.
- Upgrade assertions: all three `LegacyPrinterQrBinding` foreign keys reported `confdeltype='r'` (RESTRICT); binding count remained 1 and ID remained `b-repair-test`; delete attempts for the referenced PrinterQr, Machine and PrinterDevice each raised `foreign_key_violation` and were correctly blocked.
- Fresh-install migration deploy exited 0. Upgrade-path migration 18 completed BEGIN/ALTER/COMMIT successfully; post-repair verification passed after correcting a test-query cast (`confdeltype::text`).
- These are disposable local databases only. No staging/prod migration, backup, deployment, QR operation, Agent restart, printing, payment change, commit or push was performed.
