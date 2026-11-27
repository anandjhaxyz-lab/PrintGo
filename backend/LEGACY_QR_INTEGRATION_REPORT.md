# Legacy QR alias integration report

Date: 2026-11-27
Workspace: D:\PrintGo-Staging-QRGuard-Worktree
Branch: fix/staging-printer-qr-guard
Base HEAD before integration: 0fdac292ade05ca8b2c202d6f7c11a04158a6314

## Scope

Integrated the approved legacy machine-level QR alias feature into this candidate branch only. Existing candidate code was diff-reviewed before the four existing runtime files were updated. Existing approved QR identities and mappings were not edited.

## Integrated changes

- Added LegacyPrinterQrBinding Prisma model and reverse relations on Machine, PrinterDevice, and PrinterQr.
- Added migration 20261127000017_legacy_printer_qr_bindings.
- Added SUPERADMIN-only approve and audited revoke service/controller routes.
- Revocation is terminal for a QR binding; the unique row remains as a tombstone and the same QR cannot be rebound. A replacement/new QR is required.
- Added public metadata and customer session resolution for explicitly approved aliases.
- Added per-device telemetry lookup; missing/stale telemetry fails closed without machine-wide fallback for device-bound sessions.
- Added focused tests for approval, revocation, telemetry, metadata/session resolution, and read-only guard behavior.
- Updated the existing Phase 2 QR test's in-memory Prisma mock to return no legacy alias for its existing legacy fixtures.

## Verification

- Prisma schema validation with Prisma CLI 5.22.0: PASS.
- Node syntax checks for all changed runtime files: PASS.
- Targeted integration/regression run: 15 suites, 160 tests passed, 0 failed.
- Included legacy QR tests, read-only guard tests, Phase 2 QR API tests, printer-device admin, dispatch, authorization, job-binding, and telemetry suites.
- git diff --check: PASS.
- Migration SQL was copied from the isolated implementation.

## Tests not run

- phase3_admin_dashboard_qr_integration.test.js and phase4_customer_mobile_qr_flow.test.js require a local disposable PostgreSQL target named printgo_disposable_target on port 5433 (or GitHub Actions port 5432). No such disposable target was provisioned for this regression run, so both suites were intentionally not run against any other database.
- The earlier combined attempt correctly stopped both suites at their database-configuration preflight; no connection was made.

## Boundaries

- No staging or production deployment.
- No staging or production database access or migration.
- No Agent restart, physical printing, payment configuration, or customer QR remapping.
- No commit or push performed.
- Candidate node_modules lacked several packages; targeted tests used the existing dependency directory from D:\PrintGo\backend via Jest --modulePaths. No dependency files were changed.

## Disposable PostgreSQL follow-up — 2026-11-27

- A fresh PostgreSQL 16 cluster was created exclusively for local testing, bound to `127.0.0.1:5433`, database `printgo_disposable_target`.
- All 18 candidate migrations, including `20261127000017_legacy_printer_qr_bindings`, applied successfully after removing a UTF-8 BOM at the start of the candidate migration SQL. SQL statements were otherwise unchanged.
- Phase 3 Admin Dashboard QR integration: **10 passed, 0 failed**. The suite's cleanup completed successfully.
- Phase 4 Customer Mobile QR flow: **not run**. The host safety layer blocked the test execution request before the process started; no Phase 4 test result is claimed.
- Disposable PostgreSQL was stopped. Its data directory, temporary credentials, generated Prisma client, temporary junction, schema copy, and test logs were removed. Port 5433 has no listener.
- The installed `postgresql-x64-16` Windows service remains Running and was not modified.
- No staging/production DB, deployment, payment configuration, printer mapping, Agent restart, or physical printing was performed.
- Phase 4 Customer Mobile QR flow: **22 passed, 0 failed** on the disposable local database.
- Redis was explicitly disabled (`REDIS_URL` and `REDIS_HOST` empty; `QUEUE_REDIS_REQUIRED=false`; `NODE_ENV=test`). Queue calls used the development/test in-memory path and the test suite's mock socket objects. The suite changed test database job states to `PRINTING` and emitted only to in-process mocks; no real Agent socket, printer, or physical print was involved.
- Phase 4 included QR lifecycle, session binding, PDF validation, pricing, demo-payment idempotency, job ownership, queue room routing, per-device QR/session/job binding, rotation preservation, legacy placeholder compatibility, and dispatch feature-gate fail-closed checks.

## Epson historical-placeholder compatibility follow-up - 2026-11-27

- Follow-up review found the first alias approval implementation accepted only NULL-bound machine QR records. The actual historical Epson QR is attached to a Phase 1 DISCOVERY_REQUIRED default placeholder, so that implementation did not yet cover the reported case.
- Updated approval to accept either a NULL-bound legacy QR or one attached to its exact same-machine default placeholder, and reject arbitrary/non-placeholder child-device mappings.
- Added regression coverage for approval of a placeholder-bound QR, rejection of non-placeholder/cross-machine mappings, customer session binding to the approved Epson device, and public metadata/device-specific availability.
- Verification after the follow-up: 12 targeted suites, 94 tests passed, 0 failed; Prisma schema validation passed; changed JavaScript syntax checks passed; git diff --check passed.
- All tests ran in the isolated local worktree using mocked Prisma / test-only queue paths. No staging or production database access, QR approval, Agent restart, physical print, payment action, deployment, commit, or push occurred.


## Independent safety review follow-up - 2026-11-27

- Review found a defense-in-depth gap: the shared alias validator did not independently prove that a pre-bound QR still referenced the exact Phase 1 placeholder. The approval service checked this, but the public metadata path could have accepted a malformed/pre-existing alias row over a directly bound QR.
- Hardened the shared validator to accept only NULL-bound QR records or the exact same-machine default DISCOVERY_REQUIRED placeholder, and reject any attempt to override a real child-device QR. Public metadata now passes the joined placeholder record into this validation.
- Added regression test proving a legacy alias cannot override an already-approved device-bound QR.
- Final targeted verification: 12 suites, 95 tests passed, 0 failed; Prisma schema valid; changed JS syntax checks passed; git diff --check passed.
- Test execution touched only the isolated worktree and test logs; generated log changes were restored. No staging/production DB, QR records, Agent, physical printer, payment config, or deployment were touched. No commit or push.

## Consolidated verification ledger — PR #24 audit-retention review

Date: 2026-11-27
Workspace: `D:\PrintGo-PR24-Audit-Fixes`
Branch: `fix/pr24-audit-retention-tests`
Base commit: `adcb6168ae71f06858e99e763d06058a40e26931`

### Audit retention correction

- Changed the `LegacyPrinterQrBinding` foreign-key delete behavior for both `PrinterQr` and `Machine` from `ON DELETE CASCADE` to `ON DELETE RESTRICT`.
- Updated the matching Prisma relations to `onDelete: Restrict`.
- This prevents deletion of a parent QR or Machine while an audit binding/tombstone references it. The target `PrinterDevice` relation was already `RESTRICT` and remains unchanged.
- Updated `migrationContract.test.js` to assert both SQL foreign-key actions and Prisma relation actions.
- Because migration `20261127000017_legacy_printer_qr_bindings` has not been applied to staging or production, the migration file itself was amended in this isolated PR branch; no follow-up database migration was run.

### Consolidated test evidence (separate runs; counts are not additive)

- Earlier integration regression run: 15 suites / 160 tests passed, as recorded above.
- Epson placeholder follow-up: 12 suites / 94 tests passed, as recorded above.
- Independent safety follow-up: 12 suites / 95 tests passed, as recorded above.
- Disposable PostgreSQL follow-up: Phase 3 admin QR integration 10 passed; Phase 4 customer mobile QR flow 22 passed in the later follow-up. These were separate suites/runs, not part of one combined suite total.
- Current PR #24 audit-retention review run after the FK correction: **7 suites passed, 36 tests passed, 0 failed**. Suites: approveLegacyQrBinding, legacyQrReadOnlyGuard, migrationContract, printerDeviceAvailability, printerQrAliasSessionFlow, resolveLegacyQrDeviceBinding, revokeLegacyQrBinding.
- Prisma CLI 5.22.0 schema validation: PASS (schema validation only; a dummy local DATABASE_URL was supplied and no database connection was made).
- `node --check` on changed runtime JavaScript files: PASS.
- `git diff --check`: PASS.

### Explicit limitations

- The current 7-suite run used mocked/in-memory test paths. It did not execute the amended SQL against PostgreSQL, so actual database enforcement of `ON DELETE RESTRICT` remains to be verified on a disposable database before staging migration.
- The earlier Phase 3/Phase 4 PostgreSQL test results were recorded before this FK-only correction; they do not verify the amended delete actions.
- GitHub CI has not yet reported a run for the PR head. Local tests do not imply GitHub CI passed.
- No staging/production database access or migration, push, PR update, merge, deployment, Agent restart, QR binding, payment change, or physical printing was performed.

### Audit-retention FK enforcement — disposable PostgreSQL verification

- Created a fresh, separate PostgreSQL 16 cluster under the isolated worktree on `127.0.0.1:5433`; it did not reuse the installed Windows PostgreSQL service or any staging/production database.
- Created only minimal parent tables (`Machine`, `PrinterQr`, `PrinterDevice`) required by the migration, then applied the exact amended `20261127000017_legacy_printer_qr_bindings/migration.sql` to the disposable database.
- Inserted one Machine, one QR, one target PrinterDevice, and one `REVOKED` binding row.
- Runtime assertions passed: deleting the referenced QR was rejected by a foreign-key violation; deleting the referenced Machine was rejected; deleting the referenced PrinterDevice was rejected; the revoked binding/tombstone remained present.
- Catalog inspection confirmed `confdeltype = 'r'` (RESTRICT) for all three binding foreign keys.
- Disposable PostgreSQL cluster was stopped; port 5433 was confirmed clear; temporary cluster/data/log files were removed. The pre-existing `postgresql-x64-16` Windows service remained Running and was not modified.
- This verifies the migration SQL's FK behavior against PostgreSQL. It is not a full application migration rehearsal against the complete PrintGo schema.
