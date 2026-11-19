# Multi-Printer Prisma Migration Review

**Review status: NOT READY TO APPLY TO STAGING — verified backup export/restore evidence outstanding**  
**Scope:** migrations `20261119000012` through `20261119000016`, the preceding legacy QR index migration `20261110000007`, the Prisma schema, the Phase 1 SQL fixture, and the relevant job/lease service paths.  
**Reviewed ref:** `docs/hyderabad-windows-physical-certification`  
**Review mode:** source and test inspection only. No migration was executed and no Staging or Production data/settings were changed.

## Baseline and evidence

The known Staging migration ledger currently ends at `20261118000011_add_cash_payment_mode_and_confirmation`. The five multi-printer migrations below are pending. The existing Machine-level QR index is created by migration `20261110000007_add_active_printer_qr_unique_index` as `printer_qrs_machine_id_active_unique`, with predicate `status = 'ACTIVE' AND machineId IS NOT NULL`.

The Phase 1 SQL fixture applies the exact 00012 migration to an isolated synthetic legacy schema. A second fixture, `backend/tests/sql/multi_printer_full_migration_chain.test.sql`, now applies the exact production SQL for 00012–00016 in order against an isolated representative legacy schema. It exercises QR index transition rules, lease uniqueness constraints, queue snapshot backfill for known/NULL/blank queue names, and preservation of legacy payment/job fields. Both fixtures run transactionally and finish with `ROLLBACK`; they do not connect to Staging.

## Migration-by-migration findings

### 00012 — `add_printer_devices`

**Assessment: structurally additive; operational preflight required.**

- Creates one default `PrinterDevice` per Machine that does not already have a device.
- The backfilled device is deliberately `DISCOVERY_REQUIRED`, `UNKNOWN`, and has a NULL `windowsPrinterName`. The migration correctly does not treat `Machine.printerModel` as a Windows spooler queue name.
- Existing `PrinterQr.publicCode` is not rewritten. QR rows are linked to the Machine's default device; sessions prefer the originating QR's device and fall back to the Machine's default; old jobs and telemetry are associated with the default device.
- The new foreign keys preserve QR/session/job/status rows when a device is removed (`ON DELETE SET NULL`). Deleting a Machine cascades to its devices, which in turn clears those optional device links rather than deleting the history rows.
- The Phase 1 fixture confirms the expected simple legacy case and confirms the original active-per-Machine QR index still blocks a second active QR during this phase.

**Important rollout gate — old non-terminal jobs:** 00012 assigns `printerDeviceId` to all historical PrintJobs, but it does not populate `windowsPrinterName` on the placeholder device. Migration 00016 only copies nonblank queue names that are already present on a device. Consequently, historical jobs can end up with a non-NULL `printerDeviceId` and a NULL `printerWindowsQueueName`. The current `verifyPrinterDeviceReport` implementation requires a nonblank immutable queue snapshot for every device-bound report and fails closed otherwise. Before applying 00012, enumerate and drain/reconcile all existing non-terminal or in-flight PrintJobs on Staging. Do not guess a queue from `Machine.printerModel`; if any in-flight job cannot be settled safely, stop the rollout and handle it explicitly.

The backfill updates several existing tables and creates indexes/foreign keys. Take and verify a Staging backup, inspect table sizes, and schedule the migration with the normal write/traffic controls. The migration is not destructive to historical payment/job/session/QR rows, but it is not a zero-lock operation.

### 00013 — `printer_discovery_approval`

**Assessment: functionally aligned; index cleanup/referential-integrity note.**

- Adds a per-Machine discovery inventory keyed by normalized `queueNameKey`, with review state defaulting to `DISCOVERED`. Discovery itself does not approve a physical printer.
- Adds a second unique index on `(machineId, windowsPrinterName)`. 00012 already created the case-insensitive unique functional index on `(machineId, LOWER(windowsPrinterName))`; the 00013 index is therefore redundant for non-NULL exact matches and adds write/storage overhead. **Review decision: retain it for now** because the Prisma model declares `@@unique([machineId, windowsPrinterName])`; removing it without changing the Prisma schema would create schema/migration drift. The functional index remains the stronger case-insensitive duplicate guard. Revisit this only with an explicit schema migration plan.
- `PrinterDiscovery.approvedPrinterDeviceId` is a plain nullable text field, not a foreign key. This may be intentional to preserve review history, but it permits a stale device reference if a device is ever deleted outside the supported Admin flow. Keep it documented or add a deliberate cleanup/constraint policy.

### 00014 — `printer_device_qr_uniqueness`

**Assessment: intended index transition is correct; isolated PostgreSQL regression test passed.**

- The dropped index name exactly matches the index created in 00007.
- After 00012 has mapped legacy QR records to a default device, the new device-level partial unique index enforces at most one ACTIVE QR per non-NULL `printerDeviceId`.
- The replacement legacy partial unique index enforces at most one ACTIVE QR per Machine only for rows whose `printerDeviceId IS NULL`. This allows multiple active QR codes on one Machine when they belong to different physical PrinterDevices, while retaining the legacy one-per-Machine rule for unbound QR rows.

**Verification added and passed:** the full-chain SQL fixture applies 00012–00016 in order and directly verifies: two different device-bound ACTIVE QRs on one Machine are allowed; a second ACTIVE QR for the same device is rejected; a second ACTIVE legacy (NULL-device) QR for one Machine is rejected; REVOKED/REPLACED rows do not block a new ACTIVE row; and a device-bound QR can coexist with one legacy NULL-device QR on the same Machine. CI run #44514644520 on candidate SHA `d0b149d` passed the full-chain step, and the later docs-head CI run #44514898034 also passed the same step on PostgreSQL 18.

**Rollback warning:** once multiple ACTIVE device QR codes exist on a Machine, the original one-ACTIVE-QR-per-Machine index cannot be recreated until the extra device QR codes have been revoked/replaced or otherwise reconciled. A simple application rollback does not restore the old database invariant.

### 00015 — `printer_device_dispatch_leases`

**Assessment: schema matches the current lease service; PostgreSQL row-lock behavior verified.**

- The primary key on `printerDeviceId` enforces one current lease row per physical device. The unique `requestId` index prevents a request ID from being simultaneously reused on another lease row.
- The service locks the PrinterDevice row before acquiring, renewing, or releasing a lease. It considers a lease active only while it is unreleased and unexpired; a released/expired row can be overwritten by a later acquisition. The current service TTL is two minutes.
- `ON DELETE CASCADE` removes the ephemeral lease row if its PrinterDevice is deleted. `jobShortId` is not a foreign key, so the lease table is operational coordination state, not a durable job audit ledger.

The full-chain fixture verifies the database primary-key and unique-requestId constraints, including rejection of a second lease row for one device and requestId reuse across devices. The new `backend/tests/printer_device_lease_row_lock.integration.test.js` uses two independent PrismaClient connections to verify same-device row-lock serialization and concurrent locks on different device rows. It refuses any database URL other than localhost/127.0.0.1 database `printgo_disposable_target`. CI runs #44514644520 and #44514898034 passed this integration test, together with the Admin lease and dispatch authorization suites. This is a focused concurrency regression check, not a high-volume load/soak test.

### 00016 — `print_job_queue_snapshot`

**Assessment: nullable additive change; legacy in-flight jobs remain intentionally unbound.**

- Adds nullable `PrintJob.printerWindowsQueueName` and backfills it only from a nonblank queue name already recorded on the associated device.
- It does not invent a queue name and it does not change a job's snapshot during later device remaps. New device-bound jobs are expected to capture the approved queue name at job creation.
- Because 00012 creates legacy placeholder devices with a NULL queue name, 00016 cannot populate snapshots for historical jobs assigned to those placeholders. This is consistent with fail-closed report verification, but makes the pre-migration drain/reconcile gate in 00012 mandatory.

The existing job snapshot tests cover creation from an approved device and Machine-scoped behavior for the placeholder case. The new PostgreSQL fixture additionally proves 00016 backfills a known queue name and leaves both NULL and whitespace-only mappings without a snapshot; it then changes the PrinterDevice queue mapping and confirms the PrintJob snapshot remains unchanged. Existing service tests cover report identity validation.

## Rollback and containment

1. Before migration, stop the rollout without database changes if any preflight gate is unmet.
2. After these migrations apply, prefer a forward fix or a compatible application rollback that leaves the additive schema in place. Do not drop the new columns/tables as an emergency rollback.
3. Do not switch back to the old QR application path until per-device ACTIVE QR codes have been reconciled. Recreating the old Machine-level unique index will fail while a Machine has multiple ACTIVE device-bound QRs.
4. Before a rollback that restores the old QR invariant, list ACTIVE QR rows by Machine, revoke/replace extras using the supported audited QR lifecycle, then verify the old index can be recreated on a disposable copy. No down-migration SQL is approved by this review.
5. Production remains out of scope until Staging database migration, backend/admin/customer smoke tests, and Hyderabad Windows physical certification all pass.

## Required gates before any Staging migration

- [ ] Verified current Staging logical export downloaded outside Render and a tested restore into a separate empty/non-production database; confirm PITR recovery window in the Recovery page.
- [x] Read-only preflight snapshot of Machine, PrinterQr, Session, PrintJob, PrinterStatus counts, duplicate ACTIVE QR check and orphan Machine/QR references completed on 2026-11-19. Repeat after submissions are paused immediately before migration.
- [ ] No unresolved non-terminal/in-flight legacy PrintJobs; drain or reconcile them before 00012.
- [x] Isolated PostgreSQL CI fixture applies the complete ordered set 00012–00016 to a representative pre-migration schema (full workflow #44514644520 and docs-head workflow #44514898034 passed on PostgreSQL 18; backend, frontend and Agent jobs all succeeded).
- [x] Explicit 00014 partial-index transition tests described above pass in the isolated PostgreSQL fixture.
- [x] Lease primary-key / requestId uniqueness, two-connection row-lock concurrency, and queue snapshot NULL/blank/known-name backfill assertions pass in CI.
- [x] Existing queue snapshot/report service tests remain in the backend CI workflow.
- [ ] Repeat the live Staging preflight immediately before any migration after new submissions are paused; the 2026-11-19 snapshot is point-in-time only.
- [ ] Staging-only deploy approval, smoke-test owner, and Production isolation reconfirmed.

**Final decision:** source review and isolated PostgreSQL migration/row-lock test gates passed. The latest full workflows #44514644520 and #44514898034 passed. However, live migration remains blocked pending a downloaded Staging logical export and a tested restore into a separate empty/non-production database, final post-pause data preflight, confirmed maintenance window and explicit rollout approval. Keep the Staging candidate Draft; no migration has been run on Staging or Production.


## Live Staging PrintJob preflight snapshot (2026-11-19)

A read-only query was run against Render Postgres service `printgo-db-staging` (database `printgo_staging`) after confirming the resource name and ID in the Staging database inventory. The query grouped the current `PrintJob` table by `status`.

Result at query time:
- `COMPLETED`: 9
- All other statuses: 0 rows returned
- Total PrintJobs: 9
- Observed non-completed / potentially in-flight PrintJobs: 0

This satisfies the *current point-in-time* non-terminal-job count preflight. It does not remove the need to repeat the same read-only check immediately before any migration, after stopping/pausing new submissions for the release window. The result may change as soon as new jobs arrive. It also does not close the separate 00014 PostgreSQL index-transition test gap or the complete migration/lease/snapshot test gates above.

The query was read-only; no Staging or Production data was changed.


## Backup and live schema preflight update (2026-11-19)

### Render database metadata (read-only)

- Render resource: `printgo-db-staging` (`dpg-dbqn7pifngtc7384j0hg-a`), database `printgo_staging`.
- Status: `available`; PostgreSQL `18.6`; region Singapore.
- Compute plan: `0.1c-256mb`; configured storage: 1 GB; current database size: approximately 11 MB.
- High availability: disabled.
- IP allow list: `0.0.0.0/0` (all IPv4 addresses). This was observed, not changed. Review access restrictions separately against the backend's actual egress/network requirements.
- Render Staging backend `printgo-backend-staging` remains on branch `feature/printgo-production-readiness`, auto-deploy enabled, with pre-deploy command `npx prisma migrate deploy`. Its latest listed live deployment was commit `cb4859550276bc73f1d4d3c07fc9fe011560878e`. A merge/push to the watched branch can therefore automatically deploy and apply all pending Prisma migrations.

### Live migration ledger and schema state

Read-only queries at 2026-11-19 11:30 UTC found:
- `_prisma_migrations` latest successful entry: `20261118000011_add_cash_payment_mode_and_confirmation`.
- No incomplete or rolled-back migration rows.
- None of migrations `20261119000012` through `20261119000016` are recorded.
- The target tables `PrinterDevice`, `PrinterDiscovery`, `PrinterDeviceDispatchLease` and target column `PrintJob.printerWindowsQueueName` are not present.
- Existing legacy unique index `printer_qrs_machine_id_active_unique` is present.

### Current data snapshot

- `Machine`: 1 row.
- `PrinterQr`: 1 row; 1 ACTIVE row, linked to the existing Machine.
- `Session`: 84 rows (5 CONNECTED, 4 EXPIRED, 75 WAITING_FOR_MOBILE). All have a valid Machine reference. 47 do not reference a QR row; the 00012 Machine-default-device fallback will cover these where the Machine ID is present.
- `PrintJob`: 9 rows; all 9 COMPLETED; 0 non-completed jobs at query time.
- `PrinterStatus`: 3,957 rows, all attached to the one existing Machine.
- Orphan reference checks for `PrinterQr.machineId`, `Session.machineId`, `Session.printerQrId`, `PrintJob.machineId`, and `PrinterStatus.machineId`: 0 each.
- No Machine has more than one ACTIVE legacy QR.

All of the above is a point-in-time read-only observation. No writes, migration commands, backup/restore, service maintenance mode, or deploy actions were performed.

### Backup readiness — not yet verified

The Render Postgres tool connection used for this review exposes database metadata and read-only SQL, but does not expose an action to create/download a logical export or initiate/validate a restore. The live dashboard's Recovery page must therefore be used for the backup evidence:
1. Open the Staging DB dashboard, then its **Recovery** page.
2. Confirm the available Point-in-Time Recovery window shown for this database/workspace.
3. Use **Create export** and wait for the export to complete.
4. Download the resulting `.dir.tar.gz` archive to secure storage outside the Render database/service.
5. Restore that archive into a separate empty/non-production PostgreSQL database, then verify row counts, schema and representative records before declaring the restore tested. Do not restore over the live Staging database.

Render documentation says paid Postgres databases have PITR; the recovery window is 3 days for Hobby workspaces and 7 days for Pro-or-higher workspaces. Logical exports are retained for 7 days on Render and must be downloaded for longer retention. Free compute databases do not support Render-managed backups. The actual workspace tier and the currently displayed backup/export state were not surfaced by the Render API query, so verify both on the Recovery page.

**Migration hold remains in effect:** even after backup/restore is proven, repeat the data preflight after new customer submissions have been paused. The currently live backend auto-deploys and runs `prisma migrate deploy`, so do not merge the candidate or change the watched branch until the approved Staging rollout window and partial-stack deployment guard are ready.


## Live Staging source-schema compatibility follow-up (2026-11-19)

A second read-only inspection compared the existing Staging relation columns and foreign keys with the objects/columns consumed by migration 00012 and the following multi-printer migrations.

### Compatibility findings

- All expected legacy source columns used by 00012 are present on `Machine`, `PrinterQr`, `Session`, `PrintJob`, and `PrinterStatus`.
- Existing source foreign keys are present:
  - `Machine.companyId -> Company.id` uses `ON DELETE SET NULL`.
  - `PrinterQr.machineId -> Machine.id` uses `ON DELETE SET NULL`.
  - `Session.machineId -> Machine.id` and `Session.printerQrId -> PrinterQr.id` use `ON DELETE SET NULL`.
  - `PrintJob.machineId -> Machine.id` uses `ON DELETE SET NULL`.
  - `PrinterStatus.machineId -> Machine.id` uses `ON DELETE CASCADE`.
- `gen_random_uuid()` resolves on the live PostgreSQL 18.6 instance even though `pgcrypto` is not installed. The 00012 UUID backfill function precondition is therefore satisfied.
- The existing legacy active-per-Machine QR index exists and the target PrinterDevice/PrinterDiscovery/DispatchLease tables and queue snapshot column remain absent.
- The only Machine has a populated printer model (`EPSON L6460 Series`) but `connectionType` is NULL. This is not a reason to guess the actual Windows queue or connection type. 00012 retains the NULL connection type; physical discovery and explicit Admin approval remain required.

### Session expiry observation

At 2026-11-19 11:33 UTC all 84 existing Session rows had `expiresAt <= now()`, including 5 rows still labelled `CONNECTED` and 75 labelled `WAITING_FOR_MOBILE`; the other 4 were labelled `EXPIRED`. No session was unexpired at query time. The migrations do not update these status values, and this review did not mutate them. Preserve this observation for the Staging smoke-test owner: verify that expired sessions are not surfaced as live customer sessions after the candidate is deployed. Do not mass-update old session statuses as part of migration preparation without a separate product-approved cleanup.

### Operational conclusion

The live source schema is compatible with the required baseline assumptions inspected for 00012–00016, and the UUID function exists. The remaining hard blocker is still the independently verified backup/restore: no export was created or downloaded, no restore drill was run, and PITR/export state and workspace tier could not be established from the available Render API response. Also repeat the row/identity and session-liveness queries after new submissions are paused in the approved maintenance window. The live Render backend is configured to auto-deploy commits and runs `npx prisma migrate deploy` as pre-deploy, so the current watched branch must not be changed by a candidate merge until all operational gates and approval are satisfied.

All queries in this follow-up were read-only. No Staging or Production data, settings, services, branches, or deployments were changed.
