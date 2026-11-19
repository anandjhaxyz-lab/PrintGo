# Multi-Printer Prisma Migration Review

**Review status: NOT READY TO APPLY TO STAGING**  
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

**Assessment: intended index transition is correct; direct migration regression test is still needed.**

- The dropped index name exactly matches the index created in 00007.
- After 00012 has mapped legacy QR records to a default device, the new device-level partial unique index enforces at most one ACTIVE QR per non-NULL `printerDeviceId`.
- The replacement legacy partial unique index enforces at most one ACTIVE QR per Machine only for rows whose `printerDeviceId IS NULL`. This allows multiple active QR codes on one Machine when they belong to different physical PrinterDevices, while retaining the legacy one-per-Machine rule for unbound QR rows.

**Verification added:** the full-chain SQL fixture applies 00012, 00013 and 00014 in order and directly verifies: two different device-bound ACTIVE QRs on one Machine are allowed; a second ACTIVE QR for the same device is rejected; a second ACTIVE legacy (NULL-device) QR for one Machine is rejected; REVOKED/REPLACED rows do not block a new ACTIVE row; and a device-bound QR can coexist with one legacy NULL-device QR on the same Machine. This runs against a real disposable PostgreSQL server in CI, not only mocked QR service tests. The fixture's migration step passed on PostgreSQL 18 in CI run #44511811143.

**Rollback warning:** once multiple ACTIVE device QR codes exist on a Machine, the original one-ACTIVE-QR-per-Machine index cannot be recreated until the extra device QR codes have been revoked/replaced or otherwise reconciled. A simple application rollback does not restore the old database invariant.

### 00015 — `printer_device_dispatch_leases`

**Assessment: schema matches the current lease service; database-level concurrency verification required.**

- The primary key on `printerDeviceId` enforces one current lease row per physical device. The unique `requestId` index prevents a request ID from being simultaneously reused on another lease row.
- The service locks the PrinterDevice row before acquiring, renewing, or releasing a lease. It considers a lease active only while it is unreleased and unexpired; a released/expired row can be overwritten by a later acquisition. The current service TTL is two minutes.
- `ON DELETE CASCADE` removes the ephemeral lease row if its PrinterDevice is deleted. `jobShortId` is not a foreign key, so the lease table is operational coordination state, not a durable job audit ledger.

The full-chain fixture verifies the database primary-key and unique-requestId constraints, including rejection of a second lease row for one device and requestId reuse across devices. Existing backend suites also run the Admin lease and dispatch authorization tests. This migration fixture is not a multi-connection row-lock stress test; retain that as a separate concurrency/soak check if dispatch traffic/load warrants it.

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

- [ ] Verified current Staging backup and a tested restore/rollback plan.
- [ ] Read-only preflight of Machine, PrinterQr, Session, PrintJob, PrinterStatus counts and duplicate/NULL identity cases.
- [ ] No unresolved non-terminal/in-flight legacy PrintJobs; drain or reconcile them before 00012.
- [x] Isolated PostgreSQL CI fixture applies the complete ordered set 00012–00016 to a representative pre-migration schema (migration fixture step passed on PostgreSQL 18 in CI run #44511811143; full workflow still running at the time of this update).
- [x] Explicit 00014 partial-index transition tests described above pass in the isolated PostgreSQL fixture.
- [x] Lease primary-key / requestId uniqueness and queue snapshot NULL/blank/known-name backfill assertions pass in the isolated PostgreSQL fixture.
- [x] Existing queue snapshot/report service tests remain in the backend CI workflow.
- [ ] Repeat a live Staging PrintJob status query immediately before any migration after new submissions are paused; the 2026-11-19 count of 9 COMPLETED jobs is only a point-in-time observation.
- [ ] Staging-only deploy approval, smoke-test owner, and Production isolation reconfirmed.

**Final decision:** review found no direct deletion of customer QR tokens or historical job/payment rows in 00012–00016. The new disposable PostgreSQL fixture now validates the complete ordered chain and the key 00014/00015/00016 invariants; it passed its migration step on PostgreSQL 18 in CI run #44511811143. This closes the previous SQL-fixture coverage gap. The 00013 exact-case index is intentionally retained for Prisma schema alignment, with the extra index overhead documented. The historical-job queue-snapshot issue is safe only if the final pre-migration drain/reconciliation check confirms no unresolved non-terminal/in-flight legacy PrintJobs. The 2026-11-19 live Staging query saw 9 COMPLETED and no other statuses, but that must be repeated immediately before migration after pausing new submissions. A verified Staging backup/restore point and approved deployment window are still mandatory. Keep the Staging candidate Draft; no migration has been run on Staging or Production.


## Live Staging PrintJob preflight snapshot (2026-11-19)

A read-only query was run against Render Postgres service `printgo-db-staging` (database `printgo_staging`) after confirming the resource name and ID in the Staging database inventory. The query grouped the current `PrintJob` table by `status`.

Result at query time:
- `COMPLETED`: 9
- All other statuses: 0 rows returned
- Total PrintJobs: 9
- Observed non-completed / potentially in-flight PrintJobs: 0

This satisfies the *current point-in-time* non-terminal-job count preflight. It does not remove the need to repeat the same read-only check immediately before any migration, after stopping/pausing new submissions for the release window. The result may change as soon as new jobs arrive. It also does not close the separate 00014 PostgreSQL index-transition test gap or the complete migration/lease/snapshot test gates above.

The query was read-only; no Staging or Production data was changed.
