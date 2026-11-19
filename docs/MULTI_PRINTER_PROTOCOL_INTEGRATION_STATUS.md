# PrintGo Multi-Printer — Backend / Agent Protocol Integration

**Status:** Phase 3A — persistent discovery and Admin device approval API slice  
**Branch:** `feat/multi-printer-device-qr-session`  
**Parent:** `feat/multi-printer-agent-fleet`  
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

## 4. Discovery persistence and explicit Admin binding / approval

The Agent discovers installed Windows queues locally and emits `printer_inventory_report`.

- The backend accepts this event only from an authenticated printer socket that successfully negotiated multi-printer capability.
- Queue names and metadata are normalized and bounded; duplicate queues and malformed values are rejected.
- The backend persists each complete snapshot in the new `PrinterDiscovery` table, keyed by authenticated Machine and case-normalized Windows queue name.
- Each report is serialized with a row lock on the authenticated Machine. Previously seen queues are marked `isPresent=false`; rows in the current snapshot are upserted as present with first/last-seen timestamps.
- The committed snapshot is then forwarded to the Admin Socket.IO room as `printer_inventory_report`. A persistence failure is acknowledged as rejected and is not broadcast as a successful inventory update.
- Discovery does not create, bind, approve, activate or mutate PrinterDevice records. The discovery-to-device relation is set only by an explicit Admin bind operation.

Admin API endpoints added in this slice (all behind existing Admin authentication, role checks and read-only guard):
- `GET /api/admin/machines/:id/printer-discovery` — current queue inventory; `?includeAbsent=true` includes historical/absent queues.
- `GET /api/admin/machines/:id/printer-devices` — Machine-scoped logical devices with discovery and QR/job counts.
- `POST /api/admin/machines/:id/printer-devices/bind-discovery` with `{ discoveryId, displayName? }` — binds the currently present exact queue to the unbound legacy placeholder where available, or creates a child PrinterDevice. It always leaves the device `PENDING_APPROVAL`.
- `POST /api/admin/printer-devices/:id/approve` — explicitly approves a mapped device only if the exact queue is still present in the latest persisted inventory; records `approvedAt` and `approvedBy`.

The bind operation enforces one PC / at most 10 queue-bound devices and rejects duplicate case-insensitive queue mappings. Approval is never automatic. This slice adds backend APIs only; a customer-facing flow and Admin UI are not part of this PR.

## 5. Device health telemetry

Approved and present devices receive independent `SpoolerMonitor` instances. Device monitor events include `printerDeviceId`.

Backend:
- Requires a negotiated fleet-capable printer socket.
- Verifies `printerDeviceId` belongs to the authenticated `socket.machineId`.
- Updates only that PrinterDevice's `healthStatus` and `lastTelemetryAt`.
- Broadcasts `printer_device_status_update` to Admin sockets.
- Does not write these per-device readings into the legacy Machine-wide PrinterStatus stream. This prevents one child printer from changing the current legacy customer availability calculation before device-bound QR/session routing is implemented.

## 6. Explicitly deferred

- No multi-printer print dispatch: existing `physical_print_job` still follows the legacy `PRINTER_NAME` path.
- No device-bound Session or PrintJob routing.
- No durable per-device BullMQ lanes or concurrency changes.
- No Admin frontend UI for the new discovery/bind/approval APIs yet.
- No customer QR changes.
- No Branch or multi-city functionality.
- No OTA update or local Agent install.

These items require the later device-bound routing and Admin UI gate. The registry handshake alone must not be interpreted as enabling multi-printer production printing.

## 7. Tests and validation

Automated tests cover:
- Protocol and journal compatibility checks.
- Windows x64 capability negotiation and unsupported-platform fallback.
- Authenticated Machine scoping even when the payload includes a different Machine ID.
- Safe registry DTO and maximum fleet size.
- Cross-Machine response rejection in the Agent.
- Inventory validation, duplicate prevention and negotiation/authentication gate.
- Durable inventory upsert, stale queue absent marking, and persist-before-broadcast behavior.
- Machine row-lock serialization for inventory and Admin binding/approval operations.
- Explicit device binding to exact queue, default legacy placeholder reuse, max-10 enforcement, and no implicit approval.
- Explicit approval requires the same queue to be present in the latest inventory.
- Device telemetry identity tagging.

CI runs on disposable test infrastructure only. Passing CI does not certify real Windows queue/driver behavior.

## 8. Safety boundary

This branch is a Draft PR layered on the separate Phase 2 Draft PR. No Staging DB migration, Render deployment, Production change, client PC access, Agent OTA update or physical print test is authorized or performed. Physical verification must happen on the client's actual Windows PC in Hyderabad after reviewed protocol and release gates.
