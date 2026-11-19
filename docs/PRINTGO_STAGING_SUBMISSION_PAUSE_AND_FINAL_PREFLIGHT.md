# PrintGo Staging — Submission Pause and Final Preflight

**Review date:** 19 November 2026  
**Status:** PREPARATION ONLY — no traffic pause, maintenance-mode change, migration, deploy, branch change, or Production action has been performed.

## 1. Current Staging inventory (read-only)

### Backend service
- Service: `printgo-backend-staging` (`srv-dbqpapon74is73csbc80`)
- URL: `https://printgo-backend-staging.onrender.com`
- Tracked branch: `feature/printgo-production-readiness`
- Auto-deploy: enabled on commit
- Build: `npm install && npx prisma generate`
- Pre-deploy: `npx prisma migrate deploy`
- Start: `npm start`
- Health path: `/api/health`
- Plan: paid `0.5c-512mb`
- Render Maintenance Mode: currently disabled (`maintenanceMode.enabled=false`)

**Critical:** A commit to the tracked branch can start a deployment, and the pre-deploy command automatically applies all pending Prisma migrations. Do not merge/push the candidate to this branch until the release path has been deliberately isolated and explicitly approved.

### PostgreSQL
- Resource: `printgo-db-staging` (`dpg-dbqn7pifngtc7384j0hg-a`)
- Database: `printgo_staging`
- PostgreSQL: 18.6
- Plan: `0.1c-256mb`; disk 1 GB; region Singapore; HA disabled
- Status: available

## 2. Latest live read-only snapshot (2026-11-19 13:09–13:10 UTC)

This is a point-in-time snapshot taken while Staging remained publicly reachable. It is **not** the required post-pause final preflight.

| Check | Observed result |
|---|---:|
| Machine | 1 |
| PrinterQr | 1 |
| Session | 84 |
| PrintJob | 9 |
| PrinterStatus | 4,150 |
| PrintJob COMPLETED | 9 |
| Non-terminal PrintJobs | 0 |
| Session rows with expiresAt > now() | 0 |
| ACTIVE PrinterQr | 1 |
| Payment | 9, all SUCCESS |
| PaymentEvent | 0 rows |
| Refund | 0 rows |
| ReconciliationRecord | 0 rows |
| Orphan Machine/QR references checked | 0 |
| Target migrations 00012–00016 not yet applied | 5 |

Session status labels at the same time were:
- CONNECTED: 5
- EXPIRED: 4
- WAITING_FOR_MOBILE: 75

All 84 Session rows had `expiresAt <= now()`. Preserve this fact; do not silently rewrite statuses as part of rollout preparation. Verify application behavior for expired sessions in the post-deploy smoke test.

PrinterStatus is telemetry and continued to increase during inspection (4,148 in the first query and 4,150 shortly after). The restored export copy had 4,011 rows. This is consistent with a changing live telemetry table; do not treat an exact live-count match as a static backup acceptance criterion.

The target multi-printer migrations 00012–00016 are still pending on Staging. The latest successful live Prisma migration remains `20261118000011_add_cash_payment_mode_and_confirmation`.

## 3. Submission pause mechanism — important behavior

The connected Render service currently has Render Maintenance Mode disabled. The service is on a paid plan, so the Render web-service Maintenance Mode feature is available.

Render documents that Maintenance Mode:
- leaves the web service running;
- makes it unreachable from the public internet;
- returns HTTP 503 for every incoming public request;
- leaves private-network and SSH access available.

This is a **coarse public-ingress lock**, not a submissions-only switch. It will block all public API routes, including customer session/job creation and uploads that pass through this backend, but it also blocks Admin API calls, Cashfree/payment webhooks, and public `/api/health` or `/api/ready` checks while active. Do not enable it during active payment settlement or while a webhook callback is expected to be processed.

No selective application-level “pause new print submissions but keep all other API/webhook routes open” control has been verified in this review. Do not assume one exists.

Official Render references:
- https://render.com/docs/maintenance-mode
- https://render.com/docs/blueprint-spec#maintenanceMode

## 4. Controlled pause procedure — operator runbook

Perform only in an approved Staging maintenance window. This section is a plan, not authorization to execute it.

### A. Before the window
1. Confirm the release/change owner, client/store operator, support contact, and start/end window.
2. Freeze candidate merges and pushes. Keep the reviewed candidate on an isolated branch not watched by the live Staging backend.
3. Reconfirm the exact target service name, ID, URL, branch, auto-deploy setting, pre-deploy command, and Staging database ID. Stop if any identifier differs.
4. Notify the store operator to stop starting new customer print sessions; remove/cover the customer QR prompt or display a clear temporary pause message. Do not ask customers to upload or pay during the window.
5. Do not yet enable Render Maintenance Mode. First allow already-started customer requests and payment flows to settle.
6. Check the Cashfree dashboard/merchant view for in-flight orders and settlement state. Confirm all expected payment callbacks have arrived and been processed. If any payment/order is pending, unknown, or inconsistent, postpone the maintenance window and reconcile it first.

### B. Drain and settle before closing public ingress
7. Run a fresh read-only Staging query for PrintJob counts by status. Require zero non-terminal/in-flight jobs. If any job is queued, processing, submitted, printing, ambiguous, or otherwise non-terminal, stop and reconcile it. Do not cancel or reprint it as a shortcut.
8. Check the Windows Agent and physical Windows spooler with the client operator. Confirm no print is still in progress and no physical result is ambiguous. Preserve job IDs and spooler evidence.
9. Query Payment status, PaymentEvent processed/error state, Refund status, and unresolved ReconciliationRecord rows. Require no pending/unknown payment state and no unprocessed/error payment event. A payment provider dashboard check is also required; an empty local event table alone does not prove no callback is in flight.
10. Capture a timestamped pre-pause baseline: core row counts, job/session/payment status groups, active QR uniqueness, and orphan-reference checks. This baseline is evidence, not the final post-pause snapshot.

### C. Enable the ingress lock (approval required)
11. With the store operator confirming no new work is being accepted and the payment owner confirming settlement is clear, explicitly enable Render Maintenance Mode on **only** `printgo-backend-staging`.
12. Verify the service now returns the expected 503 page from the public Staging URL. Record the time and Render event. Do not use the public health endpoint as a readiness check while Maintenance Mode is active; Render intercepts public requests.
13. Allow in-flight requests to drain, then repeat the read-only database checks. Require zero non-terminal PrintJobs and no pending/unprocessed payment work. If any discrepancy appears, stop and investigate while public ingress remains closed.

### D. Final migration preflight while ingress is closed
14. Confirm a verified logical backup/export exists and the restore drill evidence is attached. Separately record the exact PITR recovery window shown in the Render Recovery page; restore-test PASS does not itself prove the current PITR retention window.
15. Confirm the final post-pause source snapshot:
    - zero non-terminal PrintJobs;
    - no ambiguous/in-flight physical print;
    - no pending/unknown Payment;
    - no unprocessed or errored PaymentEvent requiring action;
    - no pending/failed Refund or unresolved reconciliation discrepancy;
    - one expected Machine and expected active QR mapping;
    - zero orphan references;
    - latest successful migration is still 00011 and exactly 00012–00016 are pending.
16. Confirm the candidate's complete Prisma migration directory list and run `npx prisma migrate status` against the confirmed Staging DATABASE_URL using the exact reviewed candidate. Do not infer the complete pending set solely from the five named migrations.
17. Reconfirm the backend deployment path cannot accidentally auto-deploy a partial stack. Because auto-deploy is currently enabled and pre-deploy runs `npx prisma migrate deploy`, do not push to the watched branch or merge a Draft PR as a way to “test” the pause.
18. Obtain explicit written approval for the exact Staging release SHA, database target, migration window, smoke-test owner, and rollback decision owner. If any item is missing, leave Maintenance Mode on only if the operator-approved maintenance window has already started; otherwise do not enable it.

## 5. Deployment and reopening sequence (only after separate approval)

1. Keep public ingress closed while the exact approved candidate is deployed and the configured `npx prisma migrate deploy` pre-deploy step runs.
2. Inspect Render deploy and pre-deploy logs. Stop on any migration failure, unexpected pending migration, wrong commit, wrong database, or target ambiguity.
3. Verify the migration ledger directly through a trusted database connection. Confirm all candidate migrations completed, with no failed or rolled-back entries.
4. Confirm the backend process is available. Public health/readiness URLs will still be intercepted while Maintenance Mode is enabled.
5. Once the deployment and database checks are clean, disable Maintenance Mode on Staging only. Then immediately verify `/api/health` and `/api/ready` (require HTTP 200 and ready state) and run Admin/Customer smoke tests.
6. Keep the feature flag disabled for baseline smoke tests. Verify login, Admin overview, legacy Machine QR behavior, Customer page load, Staging API targeting, and payment-demo isolation.
7. Only after the approved Windows x64 Agent, device approval, QR mapping, and physical certification steps are ready may the separate multi-printer feature flag be enabled in Staging.
8. Reopen customer submissions only after the release owner and store operator confirm all smoke tests and the Hyderabad physical print checks required for that window are complete.

## 6. Stop and rollback rules

Stop immediately if:
- a non-terminal/ambiguous job or active spooler handoff remains;
- a payment is pending/unknown, an expected webhook is missing, an event has an error, or a refund/reconciliation needs attention;
- Render service/branch/SHA/database does not match the approved Staging target;
- migration status differs from the reviewed candidate;
- deployment or migration logs show any error;
- a job appears completed in software without physical evidence;
- Production resources or credentials are involved.

Do not blindly retry ambiguous jobs. Do not delete migration history, use `prisma migrate reset`, run `prisma db push`, or reverse SQL migrations during emergency containment. Prefer a compatible application rollback with the additive schema retained. A database restore requires stopped writers, explicit approval, and acknowledgement that post-backup transactions can be lost.

## 7. Current decision

**PREPARATION COMPLETE; NOT AUTHORIZED TO PAUSE OR DEPLOY.**

The backup restore drill passed locally. The live snapshot currently has zero non-terminal PrintJobs and all nine Payments in SUCCESS, but this is not a post-pause snapshot and must be repeated during the approved window. Render Maintenance Mode is currently disabled; the live Staging backend auto-deploy remains enabled on `feature/printgo-production-readiness` with `npx prisma migrate deploy` in pre-deploy. Do not change these settings, merge, deploy, migrate, or alter Production without a separate explicit release authorization.
