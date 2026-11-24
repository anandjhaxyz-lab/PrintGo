# PrintGo Multi-Printer Phase 2 — Agent Fleet Foundation

**Status:** Development foundation only  
**Branch:** `feat/multi-printer-agent-fleet`  
**Parent Phase 1 branch:** `feat/multi-printer-foundation`  
**Scope:** One Windows PC / one Agent / up to 10 registered printers  
**Physical certification:** Pending access to the client's Windows PC in Hyderabad  
**Staging and Production:** No migration, deployment, Agent rollout or print test authorized or performed.

## Implemented in this development slice

- Added a Windows-only discovery adapter using a fixed PowerShell query against `Win32_Printer`.
- The discovery query returns queue name, driver, port, Windows status fields, and basic sharing/network/default metadata.
- Queue names are returned as data; discovery never interpolates a queue name into a PowerShell command.
- Invalid JSON, malformed queue records, duplicate queue names and PowerShell errors fail closed.
- Added `PrinterFleetManager` as an in-memory registry adapter for one Machine.
- Fleet registration is supplied by an injected authenticated registry provider; discovered Windows queues alone never become approved.
- Only a server registry record with `status=ACTIVE`, non-empty `approvedAt`, a configured Windows queue name and an exact live queue-name match can resolve for physical dispatch.
- Missing/renamed queues remain unavailable and do not block other registered devices.
- An independent `SpoolerMonitor` can be created per approved device. Status checks are issued independently.
- Added journal schema v2 support. Existing v1 and legacy v0 data is read without startup rewrite; the next ordinary atomic save writes v2.
- Journal v2 records `printerDeviceId` and `windowsPrinterName` when supplied. A job's physical target cannot be changed after dispatch intent; an already-dispatched legacy job cannot be rebound to a new device.

## Deliberately not wired to physical dispatch yet

The current backend does not yet expose the Phase 3 authenticated device-registry/capability contract or device-aware print command. Therefore this slice does **not** connect the manager to a live registry provider, does not switch existing jobs from `PRINTER_NAME`, and does not create any live spooler monitors in the running Agent. This avoids an Agent/backend protocol mismatch.

The existing Machine Key, WebSocket registration, E2EE identity, provisioning marker and legacy single-printer flow are unchanged. No OTA update or local installation change is performed.

## Automated tests added

- Windows discovery command safety, normalization, empty inventory and failure cases.
- Admin approval gating and exact queue binding.
- Multiple independent monitor instances.
- One missing printer while another remains available.
- Ten-device upper bound and duplicate queue binding rejection.
- Refresh failures clear stale routing mappings.
- Journal v1 read-without-rewrite, v1-to-v2 atomic upgrade, immutable device binding, and unsupported-version fail-closed behavior.

## Pending before Gate 2 physical certification

- Connect the authenticated Agent device-registry provider to the backend contract.
- Complete the device-aware Agent hello/capability handshake.
- Wire per-device print dispatch and polling only after backend routing contract is implemented and reviewed.
- Verify old v1 journal fixtures from representative client installations.
- Inspect exact Windows 10/11 x64 build, all queue names, printer models, driver versions and USB/network port names on the client's Hyderabad PC.
- Validate 1, then 2, 5 and 10 printers with controlled test documents; capture independent health, concurrent dispatch and restart/recovery evidence.

## Safety boundary

This branch is a development-only extension of the Phase 1 Draft PR. No changes have been made to Render, Staging or Production. Do not merge the Phase 1 or Phase 2 branch, apply a Staging schema migration, install drivers, replace the client Agent, or run physical test prints until the relevant gate is reviewed and separately approved.
