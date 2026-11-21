# PrintGo — Ambiguous Print & Refund Protection Safety Specification

## 1. Overview & Purpose

This document specifies the safety controls and reconciliation architecture implemented in `PrintGo-PR19-SafetyFollowup` (branch `fix/pr19-ambiguous-refund-safety`).

In physical kiosk operations, blind trust in downstream network responses or transient operating system spooler signals risks severe business anomalies:
1. **Double Loss Risk**: Paper ejects or partially prints, but backend erroneously fails the job and triggers an automated refund.
2. **Double Refund Risk**: Network timeouts or provider 5xx/409 errors trigger blind retries that regenerate provider identities, leading to duplicate disbursements from Cashfree balances.

This specification establishes strict fail-closed boundaries across agent spooler monitoring, backend socket ingestion, stuck-job recovery, and Cashfree payment reconciliation.

---

## 2. Print Completion & Ambiguity Semantics

### 2.1 Spooler Clearance vs. Sensor Physical Ejection
Standard USB and virtual GDI/PCL printers in kiosk deployments do not possess reliable hardware completion sensors. When a job disappears from the Windows Print Spooler (`Get-PrintJob`), this indicates only that:
- Spooler memory buffer has transferred bytes to the printer firmware/controller buffer.
- It does **not** prove physical paper emergence or completion.

Consequently:
- Protocol event `print_physical_success` is superseded by `print_spooler_cleared`.
- Backend socket handler requires positive observation evidence (`wasSeenInQueue === true`) and strict multi-tenant ownership validation (`job.printerDeviceId === report.printerDeviceId`).
- Audit history records the factual truth: `"Print job cleared from Windows spooler queue (spooler clearance verified; hardware lacks paper-out exit sensor)"`.

### 2.2 Post-Dispatch Ambiguity Protection
If an error occurs after handoff (`DISPATCH_INTENT` or `PRINTING`):
- Errors such as `PaperJam`, `PaperOut`, `Error`, or spooler polling timeouts indicate that paper may have partially fed or printed.
- The printer agent emits `print_physical_ambiguous` (never `print_physical_error`).
- The backend socket handler locks the job in `PRINTING` status (`isAmbiguous: true`), preventing automatic transition to `FAILED` and suppressing automated refund dispatch.
- Resolution requires authorized human/administrative intervention via `resolveAmbiguousJob`.

---

## 3. Stuck PRINTING Job Recovery (`reconcileStuckPrintingJobs`)

Legacy watchdog routines erroneously transitioned jobs remaining in `PRINTING` over 15 minutes to `FAILED` and issued refunds. This violated the fail-closed principle.

Under the new recovery contract (`queueService.reconcileStuckPrintingJobs`):
1. **Preserve State**: The job remains in `PRINTING` status. No automatic transition to `FAILED` or refund occurs.
2. **Persistent Incident Logging**: A `ReconciliationRecord` is created in PostgreSQL with:
   - `discrepancyType: 'STUCK_PRINTING_JOB'`
   - `status: 'FLAGGED_FOR_AUDIT'`
   - Contextual metadata (job ID, machine ID, queue name, duration stuck).
3. **Admin Escalation**: High-priority alert is dispatched to admins/operators.
4. **Agent Query**: A `reconcile_active_jobs` event is broadcast to the connected printer agent socket to inspect local journal and spooler status.

---

## 4. Cashfree Refund Idempotency & Uncertain Outcome Handling

### 4.1 Error Classification Hierarchy
All Cashfree refund responses and network exceptions are classified deterministically in `cashfreeGateway.adapter.js`:
- `isDuplicate`: HTTP 409 or response code `refund_already_exists`.
- `isTimeout`: `ECONNABORTED`, `ETIMEDOUT`, or client request timeout.
- `isConnectionReset`: `ECONNRESET`, `ECONNREFUSED`, `EPIPE`, socket hang up.
- `isServerError`: HTTP 500, 502, 503, 504.
- `isUncertainOutcome`: Any timeout, connection reset, or 5xx server error occurring after the request payload was transmitted over the wire.
- `isDefinitiveFailure`: HTTP 400 with invalid order/payment credentials or explicit business rejection before execution.

### 4.2 Idempotency & Identity Immutability
- **Provider Refund ID Preservation**: Once a refund record is claimed or created, its `gatewayRefundId` is immutable. Retries never generate a second provider identity (`uniqueRefundId`).
- **Uncertain Outcomes**: On `isUncertainOutcome`, status remains `PROCESSING` and `retryEligible` is set to `false`. Blind external retries are rejected with HTTP 409 / 502.
- **Duplicate Handling**: On `isDuplicate` (HTTP 409), the service executes immediate external reconciliation against Cashfree (`getRefundDetails`) using the existing `gatewayRefundId` without creating new external refund requests.
- **Transactional Row Locking**: Advisory locks (`pg_advisory_xact_lock`) and Prisma transactions with extended timeouts (`maxWait: 10000`, `timeout: 15000`) guarantee serial execution and eliminate race conditions.

---

## 5. Verification & Test Coverage

The implementation is verified by comprehensive unit and database integration test suites:
1. `tests/spooler.test.js`: Spooler clearance and ambiguous error emission tests.
2. `tests/pr19_safety_followup_ambiguous_printing.test.js`: Stuck-job fail-closed retention, admin alerting, and spooler clearance evidence validation.
3. `tests/pr19_cashfree_uncertain_outcome.test.js`: 8 unit test scenarios covering duplicate handling, timeouts, 5xx server errors, identity immutability, and cumulative balance protection.
4. `tests/refund_idempotency_retry.test.js`: Unit tests for retry idempotency and gateway error mapping.
5. `tests/job_resolution_concurrency.integration.test.js`: Multi-process PostgreSQL integration testing conflicting vs matching admin resolutions.
6. `tests/refund_concurrent_retry.integration.test.js`: Multi-process PostgreSQL integration testing concurrent refund attempts and reconciliation recovery.
