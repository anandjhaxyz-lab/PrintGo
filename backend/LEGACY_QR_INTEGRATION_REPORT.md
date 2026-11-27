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
