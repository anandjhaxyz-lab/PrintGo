# PrintGo Multi-Printer — Backend / Agent Protocol Integration

**Status:** Protocol integration development slice  
**Branch:** `feat/multi-printer-backend-agent-protocol`  
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

## 4. Discovery and approval

The Agent discovers installed Windows queues locally and emits `printer_inventory_report`.

- The backend accepts this event only from an authenticated printer socket that successfully negotiated multi-printer capability.
- Queue names and metadata are normalized and bounded; duplicate queues and malformed values are rejected.
- Valid inventory is forwarded to the Admin Socket.IO room as `printer_inventory_report`.
- The backend does not auto-create, bind, approve, activate or modify PrinterDevice records from discovery.
- Discovery inventory is advisory and currently transient; persistence and Admin approval UI are subsequent work.

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
- No Admin UI persistence/approval flow.
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
- Device telemetry identity tagging.

CI runs on disposable test infrastructure only. Passing CI does not certify real Windows queue/driver behavior.

## 8. Safety boundary

This branch is a Draft PR layered on the separate Phase 2 Draft PR. No Staging DB migration, Render deployment, Production change, client PC access, Agent OTA update or physical print test is authorized or performed. Physical verification must happen on the client's actual Windows PC in Hyderabad after reviewed protocol and release gates.
