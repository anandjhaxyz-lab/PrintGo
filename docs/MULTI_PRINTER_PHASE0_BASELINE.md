# PrintGo Multi-Printer Phase 0 — Source Baseline

**Captured:** 2026-11-19  
**Repository:** `anandjhaxyz-lab/PrintGo`  
**Baseline branch:** `feature/printgo-production-readiness`  
**Baseline commit:** `cb4859550276bc73f1d4d3c07fc9fe011560878e`  
**Working branch:** `feat/multi-printer-foundation`

## Source files inspected

| Component | Path | Baseline blob SHA |
|---|---|---|
| Prisma schema | `backend/prisma/schema.prisma` | `a3edd1d0e7099fd355d95cbaee74e4928ec04920` |
| QR service | `backend/src/services/printerQr.service.js` | `629ad54c207481209758d487d6d76cd5bb7fc15d` |
| Agent entry | `printer-agent/index.js` | `077d10755b2729ee3f70b1b1297367a242215c78` |
| Spooler monitor | `printer-agent/src/spooler.js` | `eac03a3b2b61cdb18370265a86590190fbc77ddb` |
| Queue service | `backend/src/services/queueService.js` | `46d2e2f655bccd35b3887c7d0c8d635b7a4f9fff` |
| Job service | `backend/src/modules/jobs/jobs.service.js` | `c07a918d1bd22c590a2987aadb6e0a6491ddfcb6` |
| Machine service | `backend/src/modules/machines/machines.service.js` | `cd1e6d829a4338401f0326390c585fb0f7f1f468` |
| Agent journal | `printer-agent/src/journal.js` | `b798b9faf8ca05f0e8ac3b318b22206bf60e7cbf` |
| Printer availability | `backend/src/services/printerAvailability.service.js` | `f23f683e22474d66b35fed0355badba9a7e8857f` |
| Installation guide | `printer-agent/INSTALLATION.md` | `c9805a3d33ef588b283fb9f21b494a2a8a542a71` |
| Architecture | `ARCHITECTURE.md` | `618b7e953b8a3090c1e2a4fd7f5dcac33a0d54c1` |

## Current data model observations

- Prisma models include `Company`, `Machine`, `PrinterQr`, `Session`, `PrintJob` and `PrinterStatus`.
- No `PrinterDevice` or `Branch` model exists at this baseline.
- `Machine` owns the unique Agent `machineKey`, Company association and machine-level payment mode.
- `PrinterQr.machineId`, `Session.machineId`, `PrintJob.machineId` and `PrinterStatus.machineId` are current routing/telemetry relationships.
- `Session` already carries `printerQrId` and `paymentMode` snapshots.
- `PrintJob` carries `paymentMode`, `pricingSnapshot` and print settings, but no physical printer foreign key.
- Existing `PrinterQr` active uniqueness is a PostgreSQL partial index:
  `printer_qrs_machine_id_active_unique` on `PrinterQr(machineId)` where `status = 'ACTIVE'` and `machineId IS NOT NULL`.
- Machine/company is the current tenancy hierarchy. Branch/city isolation is not implemented.

## Current Agent / routing observations

- Agent configuration reads one `MACHINE_KEY` and one `PRINTER_NAME`.
- Startup validates that one `PRINTER_NAME` exists in the Windows printer queues.
- Agent creates one `SpoolerMonitor({ printerName: PRINTER_NAME })`.
- Physical print commands call `pdf-to-printer` with `printer: PRINTER_NAME`.
- Spooler polling invokes `Get-PrintJob -PrinterName '<PRINTER_NAME>'`.
- Backend dispatch sends `physical_print_job` to `machine_<machineId>`.
- BullMQ worker concurrency is currently `1` globally.
- Local journal tracks Received, Dispatch Intent, Spooler Accepted, Completed and Acknowledged states and prevents duplicate local dispatch.
- Existing ambiguity and fail-closed journal rules must be preserved.
- Machine availability uses current Machine heartbeat plus Machine-linked PrinterStatus and stale telemetry fails closed.

## Existing QR/session observations

- QR resolution creates a fresh session from the server-side QR record.
- The current QR resolver returns a Machine association and snapshots Machine payment mode.
- Current QR API accepts `machineId`; device-aware QR APIs are not yet present.
- Public QR codes are high-entropy tokens and existing rotation/revocation paths are audited.
- The existing unique-active-per-Machine index must remain until device-aware QR API and UI are ready together.

## Migration baseline

The latest migration at the baseline is:
`20261118000011_add_cash_payment_mode_and_confirmation`.

The proposed Phase 1 migration name is:
`20261119000012_add_printer_devices`.

## Physical Windows inventory — not yet captured

Source inspection does not reveal live Windows Print Management state. The following must be collected from the actual target PC before Phase 2 Agent fleet work:
- [ ] Windows edition, build and x64 architecture confirmation.
- [ ] Exact installed Windows queue names (one entry per queue).
- [ ] Physical make/model and installed driver name/version.
- [ ] USB/network port name and connection type.
- [ ] Queue paused/offline/shared state.
- [ ] One controlled test print per approved queue.
- [ ] Confirmation that 5–10 jobs can be dispatched without exhausting PC CPU/RAM/temp disk.

Do not fill this checklist using printer model labels or historical notes. In particular, `Machine.printerModel` is not a Windows queue name.

## Phase 0 status

- [x] Baseline branch and commit captured.
- [x] Prisma schema and migration sequence inspected.
- [x] Existing QR unique index identified.
- [x] Machine/Agent/queue/spooler/job/session source paths inspected.
- [x] Journal/recovery invariants recorded.
- [ ] Live Windows queue inventory pending access to target PC.
- [ ] Baseline single-printer regression test run on dedicated branch.
