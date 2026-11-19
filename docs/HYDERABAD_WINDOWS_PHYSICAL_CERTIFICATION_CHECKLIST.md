# Hyderabad Windows x64 — Multi-Printer Physical Certification Checklist

**Purpose:** Certify the device-bound QR -> Session -> PrintJob -> Windows queue -> physical print path on the client's actual Windows PC in Hyderabad.

**Scope:** One authenticated Windows x64 Agent, one Machine, and the approved queue-bound PrinterDevices on that PC (maximum 10 in the current protocol). This checklist is for Staging certification only.

**Current code baseline:** `feat/multi-printer-agent-device-dispatch` at `685a525d28423f4099f0a0048483a69e8ca110fc`. GitHub Actions run `44496278372` completed successfully. CI is not physical certification.

**Status:** NOT RUN — requires the client PC to be powered on, connected, and available. A PC that is off will correctly leave the Agent offline and customer printing unavailable.

## 1. Release and environment gates

Do not begin physical certification until all are true:

- [ ] PRs #12, #13 and #15 have been reviewed and merged in dependency order: #12 -> #13 -> #15.
- [ ] The resulting release candidate is deployed to **Staging**, and the required Prisma migrations have completed successfully there.
- [ ] Backend and Windows Agent artifacts are built from the same reviewed release candidate; record their versions / commit SHA.
- [ ] `ENABLE_MULTI_PRINTER_DISPATCH=true` is configured only in the isolated Staging environment for this controlled test.
- [ ] Production remains untouched; do not enable the feature flag in Production.
- [ ] Staging Machine ID and its Agent authentication are verified. Do not reuse a test Machine ID or key without confirming its ownership.
- [ ] The kiosk is configured to use the Staging backend, not Production.

If any gate is missing, stop. Do not install an unreviewed Agent build or apply migrations to Production.

## 2. Windows PC and Agent readiness

On the actual Hyderabad Windows PC:

- [ ] Confirm Windows 10/11 x64 and record the OS build.
- [ ] Confirm the PC is powered on, not sleeping, and has stable internet access to the Staging backend.
- [ ] Confirm the intended Epson L6460 (and any additional test printers) is connected by USB or network and appears in Windows Printers & scanners.
- [ ] Print a Windows test page for each physical printer before testing the application.
- [ ] Confirm the PrintGo / NEOX Agent service or process is running under the intended account.
- [ ] Confirm the Agent has the correct Staging Machine configuration; never paste Machine Keys into screenshots, chat, or test evidence.
- [ ] Confirm Agent logs show a successful authenticated Socket.IO connection and supported protocol handshake.
- [ ] Confirm the Agent reports Windows x64 and negotiates multi-printer capability.
- [ ] In Admin Staging, confirm the Agent is **ONLINE** and heartbeat / telemetry is fresh.
- [ ] Confirm each intended Windows queue is discovered with the exact queue name, driver and port.
- [ ] Explicitly approve only the queues intended for this test. Discovery alone is not approval.
- [ ] Confirm each approved PrinterDevice is ACTIVE and bound to the correct Machine and exact Windows queue.
- [ ] Confirm device health is fresh; do not proceed with `AGENT OFFLINE`, `Connection: Unknown`, stale telemetry, or a missing queue.

## 3. Dedicated QR and customer-session identity

For each approved physical printer:

- [ ] Record its Admin PrinterDevice ID, display label and exact Windows queue name.
- [ ] Confirm it has its own permanent ACTIVE Counter QR identity.
- [ ] Scan that printer's QR from a phone using mobile data or another internet connection (not the kiosk's LAN).
- [ ] Confirm the customer page identifies the intended counter / printer.
- [ ] Confirm the resolved Session is bound by the backend to that PrinterDevice.
- [ ] Submit a controlled test document and verify the resulting PrintJob stores the same PrinterDevice ID and immutable `printerWindowsQueueName` snapshot.
- [ ] Confirm client-supplied device identity cannot override the server-side Session binding.
- [ ] Do not expose full public tokens, Machine Keys, payment secrets or customer documents in evidence.

Do not rotate or revoke a live customer QR as part of routine testing. Use an explicitly designated test QR and test counter.

## 4. Controlled physical print tests

Use the Staging **Demo Simulation** mode with the authorized demo access code and an operator supervising the printer. This mode is expected to produce real test prints. Do not use live Cashfree payments or Production payment credentials for this certification.

Run each applicable case once per physical PrinterDevice. Record the job ID and actual result.

| Test | Action | Expected result |
|---|---|---|
| P01 — Basic simplex | Submit a one-page A4 PDF, one copy, black & white, simplex | The physical page prints once on the exact queue assigned to the scanned QR; backend and Agent report the same job/device identity |
| P02 — Color | Submit a simple one-page color test document | Color output comes from the QR-selected printer; no other printer receives the job |
| P03 — Duplex | Submit a two-page A4 PDF, black & white, duplex long-edge | Both logical pages print on the same selected device with the requested duplex setting |
| P04 — Same-device FIFO | Submit two uniquely identifiable jobs to the same PrinterDevice in quick succession | Driver submission is serialized in FIFO order for that physical Windows queue; no cross-job document mix |
| P05 — Cross-device isolation | Only when at least two different approved physical printers are available, submit one job to each printer | Each job prints only on the printer identified by its own QR; one device's queue failure does not redirect work to another |
| P06 — QR separation | Scan each test printer's QR separately and submit a uniquely labelled page | Every page appears only on its matching physical printer |

If only the Epson L6460 is available, run P01–P04 and mark P05 as **NOT RUN — second physical printer unavailable**. Do not simulate a second physical printer and claim hardware certification.

## 5. Offline, recovery and safety checks

Perform only in Staging, with no real customer jobs or live payments:

- [ ] With the PC/Agent intentionally unavailable, confirm Admin reports the Agent offline and the customer page pauses upload/payment for the unavailable counter.
- [ ] Restore the PC, internet and Agent. Confirm the Agent reconnects, fresh telemetry arrives, Admin changes to ONLINE, and customer status clears after refresh / fresh status delivery.
- [ ] Confirm reconnect does not create duplicate jobs or automatically re-submit an ambiguous print.
- [ ] For any interrupted driver handoff, inspect the journal, spooler and backend ledger before deciding the outcome. An ambiguous result must remain locked for operator reconciliation; do not blindly retry.
- [ ] Confirm retry policy is respected: maximum 3 total attempts per transaction, including the original attempt.
- [ ] Confirm an ambiguous prior attempt blocks reprint until resolved. Any authorized reprint reason must contain at least 10 non-whitespace characters.
- [ ] Confirm Admin disable/remap is blocked with conflict while a live dispatch lease exists; perform this only with a controlled test job and verify the lease has cleared before further changes.
- [ ] Verify that a remap affects future jobs only: an already-dispatched job's report is checked against its immutable queue snapshot and cannot be redirected to the new queue.
- [ ] Confirm no device-bound job silently falls back to the legacy `PRINTER_NAME` route.

Stop testing immediately on wrong-printer output, duplicate physical output, false success without a physical print, identity mismatch, unexpected refund, or a stuck paid job. Preserve logs and job IDs; do not retry an ambiguous job.

## 6. Evidence to capture

For every case, record:

- Test ID and pass / fail / not-run result.
- Date/time with timezone and operator.
- Staging release commit SHA, backend version and Agent version.
- Machine ID (masked), PrinterDevice ID, display label and exact Windows queue name.
- PrintJob short ID, requested settings and final backend status.
- Agent heartbeat / telemetry timestamp and relevant sanitized log excerpt.
- Admin fleet screenshot and customer page status screenshot.
- Photo or scan of the physical output, with document contents redacted if needed.

Never attach Machine Keys, access tokens, full QR tokens, payment secrets, personal documents or unredacted customer information.

## 7. Exit criteria and sign-off

Certification passes only when:

- [ ] All applicable tests P01–P06 pass, with any not-run cases explicitly documented.
- [ ] Every physical print comes from the printer assigned to the scanned QR.
- [ ] No wrong-device print, duplicate print, silent fallback, false success or unresolved stuck paid job remains.
- [ ] Offline and reconnect behavior is understood and recovers with fresh Agent telemetry.
- [ ] Ambiguous outcomes, retry limits, dispatch leases, and Admin lifecycle conflicts behave fail-closed.
- [ ] Evidence is reviewed and attached to the release record.

**Result:** NOT CERTIFIED / PASS / FAIL

**Client operator:** ____________________  
**Engineering reviewer:** ____________________  
**Date:** ____________________  
**Outstanding issues / exclusions:** ____________________

A Staging certification pass is not Production authorization. Production rollout requires a separate reviewed deployment plan, explicit approval, Production migration verification, and a controlled rollout decision.
