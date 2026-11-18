# PrintGo Multi-Printer Implementation Specification v1

**Status:** Phase 0 / Phase 1 foundation  
**Target:** One Windows PC, one PrintGo Agent, up to 10 registered physical printers  
**Initial rollout:** One shop only  
**Future compatibility:** Company -> Branch -> Machine -> PrinterDevice  
**Production:** Explicitly out of scope; all implementation must remain on the Staging feature branch.

## 1. Goals and non-goals

### Goals
- One Windows PC (one existing Machine identity and one Agent process) can manage 1–10 independently registered physical printers.
- Each physical printer has a stable cloud identity and its own permanent customer QR code.
- Every customer Session and PrintJob is bound server-side to the physical printer selected by that QR.
- Each printer has its own ordered print lane, health/telemetry and job history.
- Jobs for different printers may run concurrently, subject to a configurable PC-wide safety limit.
- An unavailable printer must not block other printers.
- Existing single-printer installations, QR URLs, payment snapshots, journal history, E2EE identity and recovery semantics remain compatible.
- Database relationships include a future branch extension point without implementing branches in this release.

### Non-goals for this release
- Multi-PC fleets inside one Machine record.
- Multi-branch, multi-city UI or rollout.
- Per-printer pricing or payment-mode overrides. Existing Machine/shop-level settings remain authoritative.
- Automatic physical reprints after uncertain dispatch.
- Replacing the existing Machine Key, Agent socket identity or E2EE keypair.
- Customer app installation; existing browser + QR journey remains.

## 2. Current source baseline

Baseline branch: `feature/printgo-production-readiness`  
Baseline commit: `cb4859550276bc73f1d4d3c07fc9fe011560878e`

Verified source facts:
- `Machine` is the current PC/Agent identity and owns one `machineKey`, existing machine-level payment mode and company association.
- `PrinterQr` currently references `Machine`; a PostgreSQL partial unique index permits at most one ACTIVE QR per Machine.
- `Session` stores `machineId`, `printerQrId` and a payment-mode snapshot.
- `PrintJob` stores `machineId`, pricing/payment snapshots and print settings, but no physical printer identity.
- `PrinterStatus` currently reports at Machine level.
- The Agent reads one `PRINTER_NAME` from its environment, validates that one Windows queue, creates one `SpoolerMonitor`, and dispatches with `pdf-to-printer` using that queue name.
- Spooler polling is scoped to the configured `PRINTER_NAME`.
- Backend `queueService` routes a job to `machine_<machineId>`; the BullMQ worker currently has global concurrency 1.
- Agent has one Machine Key/WebSocket and one local durable journal with duplicate-dispatch prevention, ambiguity reporting and fail-closed corruption handling.
- The current company-to-machine relationship is retained. There is no dedicated Branch entity in this baseline.

These findings are not assumptions about physical hardware. In particular, `Machine.printerModel` is not a verified Windows spooler queue name. The real queue name, driver and port must be discovered from the Windows PC and explicitly approved.

## 3. Target entity hierarchy

Initial release:

```
Company
  └── Machine (one Windows PC / one Agent identity)
        └── PrinterDevice (1..10 physical Windows queues)
              └── PrinterQr (one ACTIVE QR per device)
                    └── Session
                          └── PrintJob
```

Future extension only:

```
Company -> Branch -> Machine -> PrinterDevice -> PrinterQr -> Session -> PrintJob
```

Do not create 10 Machine rows for 10 printers. Machine remains the PC/Agent boundary.

## 4. PrinterDevice data contract

Proposed fields:
- `id`: stable cloud UUID, never derived from the Windows display name.
- `machineId`: owning Windows PC.
- `displayName`: human-friendly Admin label.
- `windowsPrinterName`: exact approved Windows queue name; nullable until discovery/approval.
- `printerModel`, `driverName`, `portName`, `connectionType`: discovered hardware/driver metadata.
- `status`: lifecycle state: `DISCOVERY_REQUIRED`, `PENDING_APPROVAL`, `ACTIVE`, `DISABLED`, `MAINTENANCE`.
- `healthStatus`: live health: `UNKNOWN`, `ONLINE`, `OFFLINE`, `PAPER_OUT`, `JAMMED`, `ERROR`.
- `isDefault`: at most one default/legacy primary device per Machine.
- `sortOrder`: stable Admin display ordering.
- `approvedAt`, `approvedBy`: explicit approval audit.
- `lastDiscoveredAt`, `lastTelemetryAt`: freshness.

The exact Windows queue name is operational routing data, not the cloud identity. Renaming a queue must be an approved rebind of the same PrinterDevice; it must not silently create a new device or redirect an existing QR.

## 5. Phase 1 database compatibility strategy

Phase 1 is additive:
1. Add `PrinterDevice`.
2. Add nullable `printerDeviceId` references to `PrinterQr`, `Session`, `PrintJob` and `PrinterStatus`.
3. Backfill one logical `DISCOVERY_REQUIRED` primary device for each existing Machine.
4. Attach existing QR, Session, PrintJob and Machine-level PrinterStatus rows to that legacy primary device where their Machine link is unambiguous.
5. Leave `windowsPrinterName` NULL. Never copy `Machine.printerModel` into it.
6. Preserve `machineId`, existing `publicCode`, payment mode, job states, journal files, keys and all historical columns.
7. Add new per-device uniqueness/indexes, but retain the existing active-QR-per-Machine index in Phase 1. Phase 3 will replace it only when API routing is ready to create multiple active QRs under one Machine.

Historical jobs with a Machine but no resolvable physical-printer identity must remain nullable rather than being guessed. Legacy routing remains Machine/PRINTER_NAME-based until device-aware Agent and backend routing are deployed together.

The migration must not delete, rewrite or rotate any QR public code. It must not reset Agent local data.

## 6. Agent architecture

One Agent process per PC:
- Existing Machine Key and WebSocket remain the Agent's authenticated cloud identity.
- Introduce `PrinterFleetManager` to maintain approved `PrinterDeviceId -> exact Windows queue name` mappings.
- Discover installed printers through Windows PrintManagement/PowerShell (including queue name, driver, port and status).
- Discovery is informational. An Admin approval step is mandatory before a discovered queue accepts customer work.
- Use one independent `SpoolerMonitor` instance per approved device.
- Poll spooler jobs only on the corresponding queue.
- Dispatch with the exact allowlisted queue name; do not accept arbitrary printer names from customer/mobile job payloads.
- Keep local file/temp handling and E2EE at Agent level; record target PrinterDeviceId and Windows queue name in the local job journal.
- Add a backward-compatible journal schema version. Existing journals must be read without reprovisioning or data loss.
- Reconciliation reports must include PrinterDeviceId when known and preserve current fail-closed ambiguity semantics.

Agent hello/capability handshake:
- Agent reports protocol version, installation identity, Windows version/architecture and fleet capability.
- Backend does not send device-aware commands to an Agent that has not advertised a compatible protocol.
- Legacy Agent remains in single-printer mode. No automatic OTA upgrade of customer PCs during development.

## 7. Backend routing and queues

Customer QR resolution is authoritative:
- Resolve ACTIVE PrinterQr -> PrinterDevice -> Machine on the server.
- Create Session with immutable `machineId`, `printerQrId`, `printerDeviceId` and payment-mode snapshot.
- Ignore/reject any customer-supplied printer or machine override.
- Job creation copies `printerDeviceId` from the authenticated Session, never from a client-supplied value.
- On print dispatch, validate job/session/device/machine ownership and device ACTIVE/approved status.
- Emit the print event to the parent Machine Agent with the immutable PrinterDeviceId. Agent resolves it against its approved local map.

Queue rules:
- FIFO per physical PrinterDevice.
- At most one active spooler dispatch per device.
- Different devices may dispatch concurrently.
- Configurable global Agent concurrency starts at 5 and must be load-tested before increasing up to 10.
- Use durable BullMQ per-device lanes or a durable queue plus database/Redis per-device reservation. Do not depend on process-local mutexes for distributed safety.
- Enforce idempotency at job claim, queue dispatch, Agent journal and spooler correlation layers.
- No automatic reprint on uncertain outcomes. Existing ambiguous/authorization/reconciliation policy wins.
- A disconnected or paper-out device must not consume/hold another device's lane.

## 8. Printer QR semantics

- One ACTIVE QR per PrinterDevice, with history retained.
- Existing QR public codes remain valid and are mapped to each Machine's legacy primary PrinterDevice.
- Phase 1 keeps the old one-ACTIVE-QR-per-Machine constraint to avoid changing QR behaviour before APIs are ready.
- In Phase 3, update QR create/replace/revoke/list APIs and all Admin UI to require a PrinterDeviceId, then replace the old partial unique index with the new per-device index.
- A QR must never be re-bound to a different physical device without an audited replace/rotation workflow.
- Replacing a QR retains existing revocation reason and historical session references.

## 9. Telemetry and Admin

Separate PC health from printer health:
- Machine heartbeat and Agent connection are PC-level.
- PrinterDevice health is per queue/device.
- Missing/stale telemetry fails closed to UNKNOWN/OFFLINE; never infer ONLINE.
- PrinterStatus can retain Machine association and optionally add PrinterDevice association during migration.
- Admin inventory displays discovered, approved, active, disabled and unavailable queues.
- Job ledger includes physical printer; filters and history are device-aware.
- Test Print requires explicit Admin action, a safe test document, visible target printer and confirmation.
- One device error must not mark Machine offline or block unrelated printers.

## 10. Security and tenant boundary

- Parent Machine is the trust and Agent-auth boundary.
- Agent may only report/dispatch devices registered to its Machine.
- Customer QR/session determines PrinterDevice; never trust the client to choose a device ID.
- Admin permission checks traverse PrinterDevice -> Machine -> Company.
- Reject device IDs belonging to another Machine/Company.
- Do not expose Machine Key, public/private E2EE keys or local Windows credentials to device discovery APIs.
- No raw PowerShell command strings or user-supplied queue names; validate and allowlist approved queue names.
- Rate-limit discovery and administrative mutations.
- Audit device registration, approval, disable, rebind and QR lifecycle changes.
- Deep Company/Branch tenant isolation audit remains a release prerequisite before multi-branch rollout.

## 11. Payment, pricing and customer compatibility

- Keep current Machine/shop-level pricing profile and payment mode for all child printers in v1.
- Snapshot the same payment mode into Session and PrintJob as existing flows do.
- Cash at Counter, Cashfree, refund, reconciliation and Service Value semantics must remain unchanged.
- Same mobile web UX and public QR URL pattern. No app download.
- QR routing chooses the printer, not a new customer-facing setup step.

## 12. Staged implementation and acceptance gates

### Phase 0 — Baseline and hardware inventory
- Record branch/commit, existing schema, migration list, QR constraints, Agent config, journal version and test baseline.
- Inventory actual Windows queue names, models, driver names, USB/network ports on the target PC.
- Produce a signed-off 1–10 device mapping sheet. Do not invent Windows queue names from printer model labels.

**Gate 0:** source baseline archived; Windows inventory captured; no production changes.

### Phase 1 — Additive database foundation
- Add Prisma model, nullable relations, additive SQL migration, primary legacy-device backfill and indexes.
- Validate with Prisma CLI, migrate against a fresh disposable database and a Staging DB snapshot/restore in a controlled test environment.
- Test row counts, FK integrity, old QR URLs, old sessions/jobs, old statuses and rollback procedure.

**Gate 1:** no row loss; old code paths still work; old QR codes unchanged; Windows queue name remains NULL pending discovery.

### Phase 2 — Agent fleet
- Discovery, Admin approval manifest, multiple spooler monitors, per-device polling and journal v2 compatibility.
- Unit tests with mocked PowerShell plus physical verification on actual Windows queues.

**Gate 2:** one Agent reports 5–10 devices independently; old journal is readable; no device can be used without approval.

### Phase 3 — Routing and durable queues
- Device-bound QR session, job snapshot, queue lane and Agent command payload.
- Replace old QR uniqueness constraint only after both backend and Admin UI are ready.

**Gate 3:** 100% routing isolation; same-device FIFO; cross-device concurrency; no duplicate print on retries/restarts.

### Phase 4 — Admin UI
- Discovery/approval, health, QR, test print and job ledger.

**Gate 4:** Admin can manage 5–10 printers without API/manual DB intervention.

### Phase 5 — Reliability and physical integration
- USB/network, online/offline, paper out, jam, printer restart, PC restart, Agent restart, Redis interruption, ambiguous spooler outcomes and mixed file/settings matrix.

**Gate 5:** test evidence for every registered printer; all safety regressions pass.

### Phase 6 — Single-shop pilot
- Two printers first, then five, then ten.
- Monitor queue depth, job latency, printer health and recovery.
- Do not add branches or cities until single-shop acceptance is signed off.

**Gate 6:** operational sign-off and rollback rehearsal.

## 13. Required tests

- 10 queues discovered; duplicate/renamed queue handling.
- Approval required before activation.
- Per-device QR uniqueness and isolation.
- Customer cannot override PrinterDeviceId.
- Existing QR continues to route to legacy primary device.
- Two printers print concurrently; same printer stays FIFO.
- One printer offline/paper out/jammed while others proceed.
- Agent disconnect/reconnect and heartbeat staleness.
- Agent crash before dispatch, at dispatch intent, after spooler accept and after physical completion.
- Journal v1 read under v2 code without mutation/reprovisioning.
- Redis/BullMQ failure does not trigger unsafe in-memory reprint in production.
- Cross-Machine and cross-Company device ID rejection.
- Cash, Cashfree, refunds, Service Value and invoice/reconciliation regressions.
- Windows queue name injection/quoting validation.
- 5 and 10 printer load/CPU/RAM/temp disk stress tests.

## 14. Deployment and rollback

- All work stays on `feat/multi-printer-foundation` and subsequent dedicated feature branches/PRs.
- No commit to production branch and no production Render deploy.
- Additive Phase 1 migration first lands in code but is only applied to a disposable test database until explicitly approved for Staging.
- Do not run `prisma db push` against Staging or Production.
- Before applying the migration to Staging: take/verify database backup, verify restore, inspect migration SQL, record pre-migration row counts.
- Keep feature flag OFF until backend, Admin UI and Agent protocol are compatible.
- Rollback uses application rollback plus additive-schema forward-compatible strategy. Do not drop new columns/tables as an emergency rollback while code might still use them.
- No deleting Agent journals, private keys or installation markers; no force-reprovisioning.

## 15. Phase 0 hardware inventory checklist

Capture from the target Windows PC:
- Windows version/build and architecture.
- Every queue name exactly as shown in Windows Settings / Print Management.
- Printer make/model from the physical label and installed driver.
- Driver name/version.
- Port name and type (USB001/USB00x, IP_/WSD/TCP, etc.).
- Shared/local status and whether the queue is paused/offline.
- A one-page, low-risk test print per device.
- Whether multiple printers can print concurrently on the PC without starving CPU/RAM.

Do not assume that the existing Epson L6460 is the only installed queue. Confirm live inventory before Agent fleet implementation.

## 16. Approval rule

This specification authorizes development only on the dedicated Staging feature branch. It does not authorize a Staging database migration, physical test print, Agent OTA rollout, customer pilot or production deployment. Each of those requires its own reviewed gate.
