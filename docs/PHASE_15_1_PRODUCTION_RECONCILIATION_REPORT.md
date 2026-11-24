# PRINTGO — PHASE 15.1: PRODUCTION RELEASE CANDIDATE RECONCILIATION REPORT

**Repository:** `anandjhaxyz-lab/PrintGo`  
**Workspace:** `D:\PrintGo-S3K-MULTIPRINTER-CANDIDATE`  
**Audit Timestamp:** 2026-11-24T13:54:00.000Z (19:24:00 IST)  
**Host Environment:** Windows x64 (`DESKTOP-QB6Q3BC`)  
**Production Branch:** `fix/p1-production-blockers`  
**Staging Branch:** `feature/printgo-production-readiness`  
**Mode:** STRICTLY READ-ONLY AUDIT (NO MERGE, NO PUSH, NO DEPLOYMENT, NO PRODUCTION DATABASE CHANGES)

---

## 1. EXECUTIVE SUMMARY

Phase 15.1 Production Release Candidate Reconciliation was executed to establish an evidence-based roadmap for merging the verified Multi-Printer Architecture (from staging) with the hardened production branch (`fix/p1-production-blockers`).

### Key Findings
1. **Divergence Origin:** Both branches originated from common ancestor commit `71b879cffda6bcf7dae6dd67ae62a9fdb9d8c3fd` ("fix(printgo): add Cloudflare Pages SPA fallback", Nov 12, 2026).
2. **Production-Only Work (2 Commits):** Commits `738ce24` and `bb8cbf3` contain critical production-safety mechanisms:
   - Cashfree order creation lease (`ORDER_LEASE_TIMEOUT_MS = 30s`) and active order reuse (`CASHFREE_ORDER_TTL_MS = 15m`).
   - Customer mobile phone validation and persistence (`customerContact.js`, `customerPersistence.js`).
   - PostgreSQL advisory locking for order creation concurrency.
   - Safe admin auto-bootstrap without requiring `MACHINE_KEY`.
   - Machine-level advertisement suppression controls (`adSuppression.service.js`).
3. **Staging-Only Work (90+ Commits):** Staging implemented the entire multi-printer architecture:
   - Migrations 10 through 16 (strictly additive, non-destructive).
   - `PrinterDevice`, `PrinterDiscovery`, `PrinterDeviceDispatchLease` models.
   - Dedicated customer QR session binding and queue snapshot immutability.
   - Printer agent protocol v2, queue discovery, and multi-printer journal v2.
   - Physically certified on Epson L6460, HP LaserJet M1136, and Canon iR-ADV 4545.
4. **Merge Conflict Footprint:** In-memory three-way merge (`git merge-tree --write-tree`) identified **17 conflicting files**. All conflicts are resolvable via structured reconciliation.
5. **Retention Recommendation:** Production-only commits **MUST BE RETAINED**. Discarding them would re-introduce Cashfree payment duplication races and admin startup crashes.

---

## 2. VERIFIED BRANCH SHAS & DIVERGENCE ANALYSIS

| Branch Reference | Exact Commit SHA | Commit Summary / Role |
| :--- | :--- | :--- |
| **Common Ancestor (Merge-Base)** | `71b879cffda6bcf7dae6dd67ae62a9fdb9d8c3fd` | `fix(printgo): add Cloudflare Pages SPA fallback` (Nov 12, 2026) |
| **Production HEAD (`origin/fix/p1-production-blockers`)** | `bb8cbf3790a2ee48662a69830aba1531af946569` | `fix: allow admin bootstrap without machine key` (Nov 14, 2026) |
| **Production Parent Commit** | `738ce24b8a309f25e2f88727aa7e1f3017674c89` | `feat: prepare PrintGo production readiness` (Nov 14, 2026) |
| **Staging Remote HEAD (`origin/feature/printgo-production-readiness`)** | `7a62f4f5959e6e4c0edc558afa786b0b34a58e84` | `fix(staging): allow non-default printer discovery approvals in read-only staging` |
| **Staging Local Candidate HEAD** | `c875b69d7ae5f5f622300a977555501e7b924e42` | `fix(staging): allow non-default printer discovery approvals in read-only staging` |

### Why the Branches Diverged
On November 14, 2026, `fix/p1-production-blockers` was created from `71b879c` to immediately harden Cashfree payment idempotency, advisory locks, customer persistence, and production bootstrap.

Subsequently, between November 17 and November 24, 2026, multi-printer fleet development commenced on `feature/printgo-production-readiness` from the same base `71b879c`, but without rebasing on `fix/p1-production-blockers`. As a result, staging evolved multi-printer routing independently while production retained the P1 payment and bootstrap protections.

---

## 3. PRODUCTION-ONLY COMMITS RETENTION AUDIT

**Mandate:** Check whether production-only commits must be retained. Never discard them automatically.

### Commit 1: `bb8cbf3790a2ee48662a69830aba1531af946569`
- **Subject:** `fix: allow admin bootstrap without machine key`
- **File Affected:** `backend/src/server.js`
- **Audit Assessment:**
  On staging, `autoSeed()` queries `prisma.machine.findUnique({ where: { machineKey } })` directly without checking if `process.env.MACHINE_KEY` is defined. In production environments where machines are registered dynamically from the dashboard, this causes database query errors or bootstrap crashes. `bb8cbf3` safely makes `machineKey` optional during bootstrap while ensuring the Superadmin account is seeded.
- **Verdict:** **CRITICAL TO RETAIN**.

### Commit 2: `738ce24b8a309f25e2f88727aa7e1f3017674c89`
- **Subject:** `feat: prepare PrintGo production readiness`
- **Key Modules Affected:**
  1. `backend/src/modules/payments/payments.service.js`:
     - Short transaction advisory locks (`pg_advisory_xact_lock`).
     - In-flight order attempt lease (`ORDER_LEASE_TIMEOUT_MS = 30s`).
     - Gateway order TTL reuse (`CASHFREE_ORDER_TTL_MS = 15m`): prevents multiple gateway order creation for the same job.
     - Suppression of duplicate payments if a prior attempt succeeded.
  2. `backend/src/utils/customerContact.js` & `customerPersistence.js`:
     - Normalizes Indian mobile phone numbers (`+91` / 10 digits starting with 6-9).
     - Persists customer contact records for Cashfree compliance and SMS/WhatsApp notifications.
  3. `backend/src/services/cashfreeGateway.adapter.js`:
     - Gateway communication wrapper with timeout handling and payload sanitization.
  4. `backend/src/services/adSuppression.service.js`:
     - Dynamic advertisement suppression for kiosks during printing/maintenance.
- **Verdict:** **CRITICAL TO RETAIN**. Discarding this would re-expose production Cashfree payments to race conditions, duplicate order creation, and missing customer contact metadata.

---

## 4. CONFLICTING FILES INVENTORY (17 FILES)

The table below lists all 17 files with merge conflicts identified via `git merge-tree`, along with their conflict nature and proposed resolution strategy:

| # | Conflicting File | Area / Subsystem | Conflict Nature | Resolution Strategy |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `backend/prisma/schema.prisma` | Database Schema | Both branches added models/enums to `schema.prisma` | Keep staging schema (superset: includes AdSuppression + PrinterDevice models) |
| 2 | `backend/src/modules/admin/admin.controller.js` | Admin API | Machine online KPI calculation vs fleet discovery | Combine `computeIsOnline` with staging fleet metrics |
| 3 | `backend/src/modules/advertisements/advertisements.controller.js` | Advertisements | Machine-level advertisement suppression | Adopt production's `adSuppression.service` integration |
| 4 | `backend/src/modules/machines/machines.controller.js` | Fleet API | Ad suppression routes vs multi-printer discovery | Merge route handlers and machine availability payload |
| 5 | `backend/src/modules/machines/machines.routes.js` | Machine Routing | Ad suppression endpoints vs multi-printer endpoints | Retain both sets of endpoints |
| 6 | `backend/src/modules/machines/machines.service.js` | Fleet Core | `computeIsOnline` helper vs staging availability service | Retain `computeIsOnline` + import `printerAvailability.service` |
| 7 | `backend/src/modules/payments/payments.controller.js` | Payments API | Customer phone/email options vs payment mode scoping | Merge controller parameters to support customer contact |
| 8 | `backend/src/modules/payments/payments.service.js` | Payments Core | Order lease & customer persistence vs staging payment logic | **CRITICAL:** Reconcile Cashfree advisory locks/leases with multi-printer routing |
| 9 | `backend/src/services/queueService.js` | Queue & Dispatch | Ambiguous refund handling vs device-bound queue dispatch | Keep multi-printer queue snapshots + production refund guards |
| 10 | `backend/src/socket.js` | WebSocket Server | Ambiguous print errors vs printer agent protocol v2 | Keep protocol v2 handshake while retaining ambiguous error events |
| 11 | `frontend/src/components/DocumentPreviewModal.jsx` | Frontend UI | Preview modal recovery vs staging fleet styling | Take staging's clean preview recovery with production fix |
| 12 | `frontend/src/components/admin/views/AdvertisementsView.jsx` | Admin UI | Ad suppression modal vs staging admin layout | Merge ad suppression view into staging admin dashboard |
| 13 | `frontend/src/components/admin/views/PrintersView.jsx` | Admin UI | Ad suppression action vs Printer Fleet Approval Panel | Retain Printer Fleet Approval Panel and include Ad suppression tab |
| 14 | `frontend/src/pages/AdminDashboard.jsx` | Admin UI | Tab routing collisions | Keep all tabs (Overview, Printers, Fleet Approval, Ads, Jobs) |
| 15 | `printer-agent/index.js` | Agent Daemon | Mutex vs multi-printer fleet manager | Adopt staging's `printerFleetManager` and per-device lanes |
| 16 | `printer-agent/src/journal.js` | Agent Storage | Journal v1 atomic write vs journal v2 device binding | Adopt staging's journal v2 (backward-compatible superset) |
| 17 | `printer-agent/src/spooler.js` | Agent Printing | Windows queue encoding vs multi-printer target queues | Adopt staging's multi-printer spooler with safe queue escaping |

---

## 5. SUBSYSTEM & ARCHITECTURAL REVIEW

### 5.1 Multi-Printer Migrations (12–16)
- **Migration 12 (`20261119000012_add_printer_devices`):** Additive. Creates `PrinterDevice` table, nullable foreign keys to `PrinterQr`, `Session`, `PrintJob`, and `PrinterStatus`. Creates a legacy default device for existing machines. **Zero data loss**.
- **Migration 13 (`20261119000013_printer_discovery_approval`):** Additive. Creates `PrinterDiscovery` table for spooler inventory.
- **Migration 14 (`20261119000014_printer_device_qr_uniqueness`):** Replaces legacy per-machine QR unique index with `printer_qrs_machine_id_legacy_active_unique` (allowing multi-device QRs while preserving single-QR legacy behavior).
- **Migration 15 (`20261119000015_printer_device_dispatch_leases`):** Additive. Creates `PrinterDeviceDispatchLease` table for dispatch serialization.
- **Migration 16 (`20261119000016_print_job_queue_snapshot`):** Additive. Adds `PrintJob.printerWindowsQueueName` and backfills from device queues.
- **Compatibility Verdict:** **100% COMPATIBLE AND ADDITIVE**.

### 5.2 Printer-Device QR Mapping & Session Binding
- Dedicated QR codes (`pq_<base64url>`) bind exclusively to physical `printerDeviceId`.
- Legacy counter QR records retain `printerDeviceId: null` and fallback seamlessly to the machine default printer.
- Session resolution enforces `FOR UPDATE OF pq` row locking, eliminating TOCTOU races with QR replacement or revocation.

### 5.3 Queue Snapshot Enforcement & Zero Silent Fallback
- `PrintJob.printerWindowsQueueName` is immutably captured at creation.
- At dispatch time, `queueService.processJob` asserts that `dbJob.printerWindowsQueueName === device.windowsPrinterName`.
- Mismatch or disabled device immediately terminates the job as `CANCELLED` / `FAILED` (`PRINTER_QUEUE_SNAPSHOT_MISMATCH`) and triggers an automatic refund. **Zero silent fallback to default printer is possible.**

### 5.4 Printer Agent Protocol & Fleet Manager
- Protocol handshake (`printer_agent_hello` -> `agent_protocol_ack`) authenticates machine identity and capabilities.
- Spooler execution uses parameterized PowerShell commands with strict queue-name encoding, preventing command injection.

### 5.5 Tenant Isolation
- Superadmins have fleet-wide visibility; Franchisees and Staff are strictly partitioned by `companyId`.
- Cross-tenant device mapping or job creation is rejected with **HTTP 403 Forbidden**.

### 5.6 Payment & Refund Idempotency
- Staging incorporates `refund.service.js` with exponential backoff and concurrency lock retry.
- Production adds the Cashfree order creation lease and 15-minute order reuse window.
- Integrating both ensures end-to-end payment integrity from order creation to refund settlement.

### 5.7 Cashfree & Render Production Configuration
- Production Render blueprint (`render.yaml`) must enforce:
  - `NODE_ENV=production`
  - `CASHFREE_BASE_URL=https://api.cashfree.com/pg`
  - `ENABLE_DEMO_PAYMENT=false`
  - `ENABLE_MULTI_PRINTER_DISPATCH=true`
  - `QUEUE_REDIS_REQUIRED=true` (Durable Redis queue required)

---

## 6. PROPOSED RELEASE CANDIDATE RECONCILIATION STRATEGY

### Phase 15.2: Controlled Integration Sequence
1. **Branch Baseline Creation:**
   Create candidate branch `release/v2.0.0-production-rc` branched from `origin/fix/p1-production-blockers`.
2. **Reconciliation Merge:**
   Merge `origin/feature/printgo-production-readiness` into `release/v2.0.0-production-rc` in the local workspace.
3. **Structured 17-File Resolution:**
   - Apply superset `schema.prisma`.
   - Preserve Cashfree order lease (`CASHFREE_ORDER_TTL_MS`), customer contact persistence, and advisory locks in `payments.service.js`.
   - Preserve bootstrap null-safety in `server.js`.
   - Adopt multi-printer dispatch, queue snapshots, and lease locks in `queueService.js` and `socket.js`.
   - Adopt multi-printer fleet manager and journal v2 in `printer-agent`.
4. **Disposable Database Verification:**
   Run the full migration chain (00 through 16) and integration test suite against `postgresql://127.0.0.1:5433/printgo_disposable_target`.
5. **Rollback Safety Policy:**
   - Both `origin/fix/p1-production-blockers` and `origin/feature/printgo-production-readiness` remain completely untouched.
   - Zero commits are pushed to remote until full verification passes.

---

## 7. STOP CONDITION & RISK ASSESSMENT

| Checkpoint | Status | Assessment |
| :--- | :--- | :--- |
| **Critical Conflict Risk** | **RESOLVABLE** | All 17 file conflicts have clear architectural resolutions |
| **Missing Migration Risk** | **NONE** | Migrations 10–16 are clean and apply sequentially on 00–09 |
| **Data-Loss Risk** | **ZERO** | All migrations are strictly additive; historical records preserved |
| **Tenant Isolation Regression** | **NONE** | Multi-printer routing preserves strict `companyId` scoping |
| **Payment Safety Regression** | **PREVENTED** | Retaining `738ce24` preserves Cashfree order lease and KYC compliance |

---

## 8. EXACT NEXT AUTHORIZATION REQUIRED

To proceed to **Phase 15.2: Release Candidate Integration & Conflict Resolution**, explicit operator authorization is required for:
1. Creating local branch `release/v2.0.0-production-rc` from `origin/fix/p1-production-blockers`.
2. Performing the 17-file reconciliation merge in `D:\PrintGo-S3K-MULTIPRINTER-CANDIDATE`.
3. Running the full backend and agent test suite against the local test database (`127.0.0.1:5433`).

---

**FINAL STATUS:**  
**READ-ONLY RECONCILIATION COMPLETE.**  
**NO MERGE EXECUTED.**  
**NO BRANCH PUSHED.**  
**NO DEPLOYMENT TRIGGERED.**  
**NO PRODUCTION DATABASE CHANGES.**
