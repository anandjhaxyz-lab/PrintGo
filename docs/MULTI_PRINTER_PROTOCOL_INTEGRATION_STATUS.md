# PrintGo Multi-Printer — Backend / Agent Protocol Integration

**Status:** Phase 4C — device-bound dispatch, per-printer FIFO, final authorization leases, and Admin lifecycle controls (Draft / CI verification pending)  
**Branch:** `feat/multi-printer-agent-device-dispatch`  
**Parent:** `feat/multi-printer-device-qr-session-binding` (stacked Draft PR #13)  
**Protocol version:** 1  
**Scope:** One authenticated Windows x64 Agent / one Machine / up to 10 queue-bound PrinterDevices  
**Physical certification:** Pending access to the client's Windows PC in Hyderabad  
**Staging / Production:** No migration, deployment, Agent rollout or client-PC change performed.

## 1. Machine authentication boundary

- The existing Machine Key remains the only Agent authentication credential.
- Socket.IO middleware resolves the Machine from the Machine Key and assigns `socket.userType = printer` and `socket.machineId`.
- The new protocol never trusts a `machineId` field supplied by the Agent.
- Every registry query uses the authenticated `socket.machineId`.
- Legacy Agents that do not send `printer_agent_hello` continue with the existing socket event flow.

## 2. Handshake contract

Agent emits `printer_agent_hello` after Socket.IO connection:

- `protocolVersion`: 1
- `agentVersion`
- `installationId` (read-only from the existing local installation marker, if available)
- `journalSchemaVersion`: 2
- `host`: platform, architecture and OS release
- `capabilities`: multiPrinter, printerDiscovery, maxPrinters

Backend returns `printer_agent_hello_ack`.

Multi-printer mode is negotiated only when all of the following are true:
- Protocol version is supported.
- Journal schema version 2 is advertised.
- Host is Windows x64.
- Agent advertises printer discovery and multi-printer support.
- Device limit is between 1 and 10.

Unsupported platforms receive an accepted hello acknowledgement with multi-printer capability disabled. The current legacy single-printer flow is not removed.

## 3. Machine-scoped registry

For a fleet-capable authenticated Agent, backend emits `printer_device_registry` with:
- The authenticated Machine ID.
- Protocol version and issue timestamp.
- Only safe PrinterDevice fields: ID, display label, exact Windows queue name, lifecycle status, approval timestamp and sort order.

The query is constrained to the authenticated Machine and queue-bound records. Unbound legacy placeholder rows are not sent to the new fleet manager. More than 10 queue-bound records fails closed. Machine Keys, E2EE keys, Company metadata and other private fields are never included.

The Agent checks that the response Machine ID matches the server's authenticated registration event / hello acknowledgement, then validates device IDs, queue names, statuses, duplicate mappings and fleet size.

## 4. Discovery and approval

The Agent discovers installed Windows queues locally and emits `printer_inventory_report`.

- The backend accepts this event only from an authenticated printer socket that successfully negotiated multi-printer capability.
- Queue names and metadata are normalized and bounded; duplicate queues and malformed values are rejected.
- Inventory is persisted as Machine-scoped discovery data, with repeat reports updating last-seen state while preserving Admin review status and any approval link.
- The Admin UI lists discovered queues and requires an explicit Admin approval action. A discovery event never creates, binds, approves or activates a PrinterDevice.
- Approval is tenant-scoped, rejects stale discovery, duplicate queue mappings, inactive Machines and the per-PC device limit, and creates an ACTIVE PrinterDevice with approval evidence.
- Registry responses to the Agent contain the authenticated Machine's queue-bound PrinterDevices only; the Agent enables a local monitor only for ACTIVE devices with approval evidence and an exact local Windows queue match.

## 5. Device health telemetry

Approved and present devices receive independent `SpoolerMonitor` instances. Device monitor events include `printerDeviceId`.

Backend:
- Requires a negotiated fleet-capable printer socket.
- Verifies `printerDeviceId` belongs to the authenticated `socket.machineId`.
- Updates only that PrinterDevice's `healthStatus` and `lastTelemetryAt`.
- Broadcasts `printer_device_status_update` to Admin sockets.
- Does not write these per-device readings into the legacy Machine-wide PrinterStatus stream. This prevents one child printer from changing the current legacy customer availability calculation before device-bound QR/session routing is implemented.

## 6. Phase 4C — device-bound dispatch and per-printer lanes

This implementation extends the already-stacked device QR/session/job binding from PR #13. It does not enable that flow by default.

Backend dispatch:
- The existing durable BullMQ publisher remains at global concurrency 1 to preserve deterministic event publication order.
- A PrintJob with `printerDeviceId` is dispatchable only when `ENABLE_MULTI_PRINTER_DISPATCH=true`, and a fresh database read confirms the exact child device belongs to the same Machine, is `ACTIVE`, has `approvedAt`, and has a non-empty exact Windows queue name.
- The device identity and queue name sent to the Agent are read from the database, never from the customer payload.
- The job is atomically claimed only while its device binding remains unchanged. The mapping is checked again immediately before Socket.IO emission; if it became invalid, the job is restored to `WAITING` and no fallback route is used.
- Legacy jobs with `printerDeviceId=null` retain the existing Machine room / `PRINTER_NAME` path.

Agent dispatch:
- Every device-bound job requests a fresh registry over the authenticated Machine socket before selecting a local queue. The Agent validates the Machine-bound registry, rediscovers local Windows queues, and refreshes its FleetManager before dispatch.
- A device-bound job requires Windows x64 multi-printer negotiation and an exact match between database `printerDeviceId` / queue name and the Agent's approved local registry. Missing, disabled, unapproved, stale or mismatched mappings fail closed; they never fall back to `PRINTER_NAME`.
- Agent lanes are keyed by normalized physical Windows queue name. Jobs targeting one physical queue are submitted to its driver in FIFO order; independent queues can prepare and submit concurrently. Legacy `PRINTER_NAME` and a child device mapped to that same queue share a lane.
- Each device continues to use its own `SpoolerMonitor` for spooler outcome observation.
- After document download/decryption and immediately before durable dispatch intent / Windows driver submission, the Agent requests a correlated backend authorization for the exact job, PrinterDevice and queue identity.
- Backend authorization locks the `PrinterDevice` row and creates one bounded two-minute dispatch lease per physical device. The Agent renews the lease while awaiting the Windows driver submission and releases it after the spooler handoff succeeds. Failed/ambiguous handoff leaves the lease to expire conservatively.
- Admin disable, enable and remap transactions acquire the same Machine/PrinterDevice row locks. A live dispatch lease blocks these mutations with HTTP 409; if Admin obtains the lock first, the final Agent authorization observes the new status/mapping and denies dispatch.
- Spooler success, physical success/error/ambiguous, and reconciliation events carry the exact device identity. Backend accepts a device-bound outcome only when both the PrinterDevice ID and exact queue name match the database job. Legacy jobs cannot claim a child PrinterDevice.
- Reconciliation receives backend-derived job-to-device bindings. A missing journal entry is treated as `NOT_DISPATCHED` only when the returned device binding matches; journal corruption, mismatch, or ambiguous dispatch remains fail-closed.

Admin lifecycle controls:
- Admins can disable an ACTIVE device with a mandatory operator reason (10–500 characters).
- Admins can remap a device only to a fresh discovery on the same Machine that is not already mapped to another PrinterDevice. Remapping preserves the stable PrinterDevice ID and permanent QR; a DISABLED device remains DISABLED.
- A DISABLED device can be re-enabled only when the Machine is ACTIVE and the exact Windows queue is present in a recent, approved discovery record for that same PrinterDevice. Enable/disable/remap actions write ActivityLog records.
- The Admin fleet panel exposes the current device status and any unexpired dispatch lease; lifecycle buttons are disabled while a lease is active. The backend independently enforces the same checks and returns 409 if a live dispatch lease exists.
- Approval, remap, enable/disable and dispatch authorization use a consistent Machine-first lock order. Dispatch authorization and Admin operations then serialize on the same PrinterDevice row to avoid disable/remap races and conflicting queue updates.

The PR does not turn on `ENABLE_MULTI_PRINTER_DISPATCH` and does not change any deployed environment variables. Physical certification on the client's Hyderabad Windows PC remains a separate gate.

## 7. Tests and validation

Automated tests cover:
- Protocol negotiation, Agent journal compatibility and authenticated Machine scoping.
- Registry refresh authorization, request ID validation, fresh queue-bound registry contents and failure handling.
- Agent FIFO ordering for the same physical queue, cross-queue concurrency, queue failure isolation, legacy/device queue collision protection, and maximum supported Windows queue-name length.
- Backend rejection of wrong PrinterDevice IDs, wrong exact queue names, incomplete bindings, and child-device claims on legacy jobs.
- Dispatch lease acquisition, same-device contention, request-id idempotency, authenticated renewal/release, expiry handling, and failure-closed authorization.
- Admin disable/remap/re-enable permission checks, operator-reason validation, fresh discovery and same-Machine constraints, duplicate mapping rejection, active-lease conflict responses, and consistent Machine-first lock ordering.
- Agent lease renewal and release behavior, including the disconnected-socket case.
- Agent fleet validation and fail-closed printer identity checks remain part of the existing Agent test suite.

CI runs on disposable GitHub Actions infrastructure only. It does not run a real Windows spooler or physical printer. Passing CI does not certify real driver behavior.

## 8. Safety boundary

This branch is intended as a Draft PR stacked directly on PR #13. No PR is merged by this work. No Staging or Production database migration, Render configuration/deployment, Production change, Agent OTA update, installation on a client PC, or physical print test is authorized or performed. Physical verification must happen on the client's actual Windows PC in Hyderabad after separate approval and reviewed release gates.
