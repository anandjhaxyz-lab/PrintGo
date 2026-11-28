# PrintGo Printer Status — Isolated RCA & Fix Report

**Date:** 2026-11-28
**Workspace:** `D:\PrintGo-Printer-Status-RCA`
**Branch:** `fix/isolated-printer-status-telemetry`
**Base:** `c875b69`
**Status:** Implemented and regression-tested in isolation; not deployed.

## 1. Read-only evidence from the confirmed PrintGo PC

The user confirmed `DESKTOP-QB6Q3BC` is the PrintGo printer PC. Local Windows queue status was inspected without changing the PC:

| Queue | Port | PrinterStatus | DetectedErrorState | WorkOffline | Interpretation |
|---|---|---:|---:|---|---|
| EPSON L6460 Series | `192.168.1.7` | 3 | 0 | False | Idle; WMI error state is Unknown; network path needs TCP confirmation |
| HP LaserJet Professional M1136 MFP (Copy 1) | `USB011` | 3 | 0 | True | Explicitly offline; must remain blocked |
| Canon Generic Plus UFR II (Copy 2) | `USB001` | 3 | 0 | False | Idle; WMI error state is Unknown; USB queue can be monitored with consumable state unknown |

The per-printer filtered WMI query was re-tested read-only and completed in roughly 0.5–0.65 seconds for the three queues. A previous 15-second broad-enumeration timeout was not reproduced in that targeted test.

Staging data also showed an Epson identity/port discrepancy: local Windows and the approved discovery row reported `192.168.1.7`, while the PrinterDevice record retained `USB019`. No mapping or database changes were made. This discrepancy still requires a separate identity/QR review before any live change.

## 2. Root-cause assessment

`Win32_Printer.DetectedErrorState = 0` means **Unknown**, not confirmed healthy and not a confirmed hardware fault. It cannot safely be treated as a generic blocking error, nor can it be treated as proof that paper/toner are available.

Monitor eligibility therefore needs contextual evidence:

- `WorkOffline` must explicitly be `False`.
- `PrinterStatus` must be `3` (Idle) or `4` (Printing).
- USB queues can proceed with WMI Unknown while paper/toner remain `UNKNOWN`.
- Network queues require a successful bounded TCP connection to the parsed printer endpoint, even when WMI says `No Error` or a consumable warning.
- Unknown connection types and network ports without a verifiable TCP endpoint fail closed.
- Explicit hardware errors, including offline, no paper, jam, door open and unrecognized error values, remain blocking.

The historical fail-closed monitor log is consistent with this health/eligibility boundary. The historical logs and present-day read-only checks do not prove that every earlier failure had one identical runtime cause; the changes below harden the code path against the observed status combinations and prevent false-positive network readiness.

## 3. Isolated changes

- `printerStatusMapping.js`: contextual health gates; explicit offline and queue readiness checks; network TCP verification before accepting healthy/warning states; consumable status remains unknown for WMI Unknown.
- `printerFleetManager.js`: apply network probing to all non-blocking network states and retain precise diagnostic reason codes instead of collapsing every failure into a generic error.
- `spooler.js`: use the same contextual health policy for live status telemetry and require TCP verification for network queues.
- `networkConnectivity.js` and `subprocessDiagnostics.js`: isolated dependency files copied from the candidate implementation; TCP probe is bounded, opens no print job, sends no payload and destroys the transient socket.
- Tests: add the observed Epson/HP/Canon status fixture, WSD/no-endpoint fail-closed coverage, network `No Error` connectivity checks, and TCP parser/socket safety tests.

## 4. Verification

- Full printer-agent Jest suite after final review: **10 suites passed, 120 tests passed, 0 failed**.
- Added regression coverage ensuring a network printer's asynchronous TCP probe retains the per-monitor status-check lock until telemetry is emitted, preventing overlapping status queries.
- `node --check` on modified and added source files: **PASS**.
- `git diff --check`: **PASS**.
- The three-printer fixture verifies Epson Network + Unknown + TCP reachable => monitor eligible; HP `WorkOffline=True` => blocked; Canon USB + Unknown + Idle => monitor eligible. This is a simulated regression fixture, not a physical print test.

## 5. Safety boundary / outstanding work

No live PC files, running processes, scheduled tasks, Windows printer settings, QR/session mappings, staging or production database rows, payment settings, or deployment targets were changed. No agent restart, physical print, commit, push, or deployment occurred.

This branch is a tested candidate only. Before rollout, separately review the Epson `192.168.1.7` vs `USB019` identity mismatch, verify the exact approved three-device registry and permanent QR/session bindings, and perform an explicitly authorized staged deployment/restart and independent physical-print validation. Do not infer that the current live agent has received this fix.
