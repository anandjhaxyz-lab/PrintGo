# Multi-Printer Prisma Migration Review

**Review status: NOT READY TO APPLY TO STAGING**  
**Scope:** migrations `20261119000012` through `20261119000016`, the preceding legacy QR index migration `20261110000007`, the Prisma schema, the Phase 1 SQL fixture, and the relevant job/lease service paths.  
**Reviewed ref:** `docs/hyderabad-windows-physical-certification`  
**Review mode:** source and test inspection only. No migration was executed and no Staging or Production data/settings were changed.

## Baseline and evidence

The known Staging migration ledger currently ends at `20261118000011_add_cash_payment_mode_and_confirmation`. The five multi-printer migrations below are pending. The existing Machine-level QR index is created by migration `20261110000007_add_active_printer_qr_unique_index` as `printer_qrs_machine_id_active_unique`, with predicate `status = 'ACTIVE' AND machineId IS NOT NULL`.

The Phase 1 SQL fixture applies the exact 00012 migration to an isolated synthetic legacy schema and checks legacy QR token preservation, session/job/telemetry backfills, payment-mode preservation, and retention of the old Machine-level QR constraint. This is useful coverage, but it is not a full execution test of migrations 00012–00016 against a sanitized copy of the current Staging baseline.

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
- Adds a second unique index on `(machineId, windowsPrinterName)`. 00012 already created the case-insensitive unique functional index on `(machineId, LOWER(windowsPrinterName))`; the 00013 index is therefore redundant for exact matches and adds write/storage overhead. It does not weaken the case-insensitive protection. Consider retaining only the Prisma-schema-represented index plus the functional case-insensitive index, with an explicit schema/migration decision.
- `PrinterDiscovery.approvedPrinterDeviceId` is a plain nullable text field, not a foreign key. This may be intentional to preserve review history, but it permits a stale device reference if a device is ever deleted outside the supported Admin flow. Keep it documented or add a deliberate cleanup/constraint policy.

### 00014 — `printer_device_qr_uniqueness`

**Assessment: intended index transition is correct; direct migration regression test is still needed.**

- The dropped index name exactly matches the index created in 00007.
- After 00012 has mapped legacy QR records to a default device, the new device-level partial unique index enforces at most one ACTIVE QR per non-NULL `printerDeviceId`.
- The replacement legacy partial unique index enforces at most one ACTIVE QR per Machine only for rows whose `printerDeviceId IS NULL`. This allows multiple active QR codes on one Machine when they belong to different physical PrinterDevices, while retaining the legacy one-per-Machine rule for unbound QR rows.

**Missing release evidence:** the current SQL fixture only executes 00012. Add an isolated PostgreSQL migration test that applies 00012 then 00014 and proves all of these outcomes: two different device-bound ACTIVE QRs on one Machine are allowed; a second ACTIVE QR for the same device is rejected; a second ACTIVE legacy (NULL-device) QR for one Machine is rejected; REVOKED/REPLACED rows do not block a new ACTIVE row. Also test mixed legacy/device-bound rows. Do not rely only on mocked QR service tests for this index transition.

**Rollback warning:** once multiple ACTIVE device QR codes exist on a Machine, the original one-ACTIVE-QR-per-Machine index cannot be recreated until the extra device QR codes have been revoked/replaced or otherwise reconciled. A simple application rollback does not restore the old database invariant.

### 00015 — `printer_device_dispatch_leases`

**Assessment: schema matches the current lease service; database-level concurrency verification required.**

- The primary key on `printerDeviceId` enforces one current lease row per physical device. The unique `requestId` index prevents a request ID from being simultaneously reused on another lease row.
- The service locks the PrinterDevice row before acquiring, renewing, or releasing a lease. It considers a lease active only while it is unreleased and unexpired; a released/expired row can be overwritten by a later acquisition. The current service TTL is two minutes.
- `ON DELETE CASCADE` removes the ephemeral lease row if its PrinterDevice is deleted. `jobShortId` is not a foreign key, so the lease table is operational coordination state, not a durable job audit ledger.

Before Staging, retain tests for concurrent acquisitions on the same device, simultaneous acquisitions on different devices, expired lease takeover, released lease reuse, and stale request/job renewal or release rejection. CI unit coverage is useful but does not replace a PostgreSQL row-lock/concurrency test.

### 00016 — `print_job_queue_snapshot`

**Assessment: nullable additive change; legacy in-flight jobs remain intentionally unbound.**

- Adds nullable `PrintJob.printerWindowsQueueName` and backfills it only from a nonblank queue name already recorded on the associated device.
- It does not invent a queue name and it does not change a job's snapshot during later device remaps. New device-bound jobs are expected to capture the approved queue name at job creation.
- Because 00012 creates legacy placeholder devices with a NULL queue name, 00016 cannot populate snapshots for historical jobs assigned to those placeholders. This is consistent with fail-closed report verification, but makes the pre-migration drain/reconcile gate in 00012 mandatory.

The job snapshot tests cover creation from an approved device and Machine-scoped behavior for the placeholder case. Add/retain a PostgreSQL migration test proving the actual 00016 backfill behavior for a device with a known queue, a NULL queue, and a blank queue, plus service tests that reject reports for a NULL/mismatched snapshot and keep the original snapshot after a remap.

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
- [ ] Isolated PostgreSQL CI test applies the complete ordered set 00012–00016 to a representative pre-migration schema.
- [ ] Explicit 00014 partial-index transition tests described above pass.
- [ ] Lease database concurrency/recovery tests pass.
- [ ] Queue snapshot backfill and immutable remap/report tests pass.
- [ ] Staging-only deploy approval, smoke-test owner, and Production isolation reconfirmed.

**Final decision:** review has found no direct deletion of customer QR tokens or historical job/payment rows in 00012–00016. However, the legacy in-flight job/snapshot gap and missing direct PostgreSQL coverage for the 00014 index transition are release gates. Keep the Staging candidate Draft and do not apply migrations until those gates are closed.


## Live Staging PrintJob preflight snapshot (2026-11-19)

A read-only query was run against Render Postgres service `printgo-db-staging` (database `printgo_staging`) after confirming the resource name and ID in the Staging database inventory. The query grouped the current `PrintJob` table by `status`.

Result at query time:
- `COMPLETED`: 9
- All other statuses: 0 rows returned
- Total PrintJobs: 9
- Observed non-completed / potentially in-flight PrintJobs: 0

This satisfies the *current point-in-time* non-terminal-job count preflight. It does not remove the need to repeat the same read-only check immediately before any migration, after stopping/pausing new submissions for the release window. The result may change as soon as new jobs arrive. It also does not close the separate 00014 PostgreSQL index-transition test gap or the complete migration/lease/snapshot test gates above.

The query was read-only; no Staging or Production data was changed.
