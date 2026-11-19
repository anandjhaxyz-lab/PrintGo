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


## Post-maintenance final read-only snapshot — 2026-11-19

### Maintenance Mode confirmation
- Render service `printgo-backend-staging` (`srv-dbqpapon74is73csbc80`) reports `maintenanceMode.enabled=true`.
- Render event `maintenance_mode_enabled` recorded at `2026-11-19T13:20:59.979371Z` (event `evt-dbvfferl550s739keru0`).
- The service remains on `feature/printgo-production-readiness`; auto-deploy is still enabled and pre-deploy remains `npx prisma migrate deploy`. No service branch, auto-deploy, deployment, or database setting was changed.
- The Maintenance Mode setting and event confirm the ingress lock is active. A separate external HTTP status probe of `/api/health` was not established in this check; public health endpoints are expected to be intercepted while the mode is active.

### Final DB snapshot after Maintenance Mode was enabled
Read-only Render Postgres queries against `printgo_staging` at `2026-11-19T13:22:22.930257Z` (latest PrinterStatus row timestamp `2026-11-19T13:23:07.238Z`) returned:

| Check | Result |
|---|---:|
| Machine | 1 |
| PrinterQr | 1 |
| Session | 84 |
| PrintJob | 9 |
| PrinterStatus | 4,173 |
| PrintJob COMPLETED | 9 |
| Other PrintJob statuses | 0 |
| Payment SUCCESS | 9 |
| PaymentEvent rows | 0 |
| Refund rows | 0 |
| ReconciliationRecord rows | 0 |
| Unexpired Sessions | 0 |
| Sessions with `expiresAt <= now()` | 84 |
| ACTIVE PrinterQr | 1 |
| Duplicate ACTIVE QR per Machine | 0 groups |
| Orphan QR/Machine, Session/Machine, Session/QR, PrintJob/Machine, PrinterStatus/Machine | 0 each |

Session status labels remain CONNECTED 5, EXPIRED 4, WAITING_FOR_MOBILE 75; all 84 expiry timestamps are in the past. Do not infer that the CONNECTED / WAITING_FOR_MOBILE labels make those sessions active; the expiry timestamps are expired. Do not mass-rewrite these records in rollout preparation.

The printer's latest recorded telemetry row showed `isOnline=true`, `paperStatus=OK`, `tonerStatus=OK`, `jamStatus=false`, machine `Main Shop Printer`, model `EPSON L6460 Series`, and `connectionType=NULL`. This is telemetry only. It does not prove a fresh physical print, the Windows spooler queue name, or physical certification. Do not infer queue name or connection type from model/status.

### Migration ledger
- Latest successful migration remains `20261118000011_add_cash_payment_mode_and_confirmation`.
- All five target migrations 00012–00016 remain PENDING; none was applied.
- No migration command was run.

### Decision after this preflight
The database checks passed for the observed snapshot and the Staging ingress lock is confirmed active. The final preflight is **PASS for the DB conditions observed at this timestamp**, but the release is **NOT AUTHORIZED TO MIGRATE/DEPLOY** yet:
1. The store operator must confirm the counter/customer intake is physically paused and no physical print/spooler handoff remains in flight or ambiguous.
2. The payment owner must confirm in the Cashfree merchant dashboard that there are no pending orders/callbacks outside the local database. Local PaymentEvent is empty and all stored Payments are SUCCESS, but that does not independently establish the external gateway has no callback in flight.
3. Record the exact PITR recovery window shown in Render Recovery. The isolated logical backup restore drill passed, but that does not prove the currently configured PITR retention window.
4. Freeze the release candidate and verify the exact complete Prisma migration status using the reviewed candidate. Reconfirm that deployment cannot be triggered through the current auto-deploy watched branch before the approved release choreography.
5. Obtain explicit release approval, maintenance-window owner, migration operator, smoke-test owner, and rollback decision owner.

Maintenance Mode was enabled by the operator; do not disable it until the operator-approved reopening sequence is completed. No Staging data or schema was modified; no deployment or migration was performed; Production remained untouched.


## Release authorization blockers rechecked — 2026-11-19

### GitHub dependency / deployment-path inspection
The current PR metadata was fetched directly from GitHub:
- PR #9: Draft, open, unmerged; base `feature/printgo-production-readiness`; head `feat/multi-printer-foundation`.
- PR #10: Draft, open, unmerged; base #9 head branch.
- PR #11: Draft, open, unmerged; base #10 head branch.
- PR #12: Draft, open, unmerged; base #11 head branch.
- PR #13: Draft, open, unmerged; base #12 head branch.
- PR #15: Draft, open, unmerged; base #13 head branch.
- PR #16: Draft, open, unmerged; documentation branch.
- PR #17: Draft, open, unmerged; Blueprint/CI sidecar branch.
- PR #18: Draft, open, unmerged; candidate head `docs/hyderabad-windows-physical-certification`, base `feature/printgo-production-readiness`.

No submitted PR reviews were returned for the inspected PRs. PR #9 directly targets the live Staging backend's watched branch. The Staging backend still has auto-deploy enabled on commit and runs `npx prisma migrate deploy` in pre-deploy. Therefore, merging PR #9 as-is can trigger a deploy of an incomplete stack and apply pending migrations. Do not merge any part of this chain until an approved release strategy isolates/controls the deployment path and the exact fully integrated candidate has approval. The connected Render integration exposes no service-update/auto-deploy-toggle action; no such setting was changed.

PR #18 changed-file inspection shows migration files 00012–00016 plus backend/frontend/Agent implementation and tests. CI validates the full chain in a disposable PostgreSQL database, but it is not equivalent to running `npx prisma migrate status` against live Staging from the exact approved candidate. The latter remains a manual, controlled release-window check.

### External payment / PITR evidence limitations
- The connected app tools provide Render service metadata, Postgres metadata and read-only SQL, but no Postgres Recovery/PITR status, Recovery-page export-list, or Cashfree merchant-order lookup action.
- Render's official API documents a dedicated endpoint `GET /v1/postgres/{postgresId}/recovery` for PITR availability, and its Recovery dashboard page displays the recovery window. Capture the actual returned `recoveryStatus` / `startsAt` or Recovery-page screenshot for `printgo-db-staging`; do not infer an exact window only from the plan tier. Official API reference: https://api-docs.render.com/reference/retrieve-postgres-recovery-info
- Render docs state PITR availability window depends on workspace plan (Hobby 3 days; Pro or higher 7 days) and logical exports are retained for 7 days. Actual PITR availability and current start time must still be checked for this database: https://render.com/docs/postgresql-backups
- No Cashfree connector is currently available in the connected app tools. Local DB has 9 SUCCESS payments and no PaymentEvent / Refund / ReconciliationRecord rows, but this does not prove there is no external gateway order or callback in flight. A payment owner must verify in Cashfree Dashboard before reopening any external ingress or running a release.
- The client Windows operator must separately confirm that customer intake is physically stopped, Windows spooler is idle, and no physical print result is ambiguous. Database status and Agent heartbeat do not prove spooler state.

### Latest read-only recheck after Maintenance Mode
At approximately `2026-11-19T13:29:41Z`:
- Maintenance Mode remains enabled in Render service metadata; the `maintenance_mode_enabled` event is present and no later service events were returned in the inspected window.
- PrintJobs remain 9 COMPLETED; non-terminal count 0.
- Payments remain 9 SUCCESS.
- Latest PrinterStatus telemetry remains online, paper OK, toner OK, jam false; `connectionType` is NULL.
- No deploy or migration event was observed after the maintenance enable in the inspected event response.

**Decision remains: NOT AUTHORIZED TO MIGRATE/DEPLOY OR REOPEN.** Keep Staging Maintenance Mode enabled until the operator, payment, PITR and release-path gates have documented proof and a separately approved release window. Production remains untouched.


## Operator confirmations and repeat checks — 2026-11-19

The user/operator confirmed in chat that:
- Cashfree Dashboard shows zero Pending/Processing orders.
- The client Windows PC print spooler is idle.

These are recorded as operator confirmations, not independently queried through a Cashfree connector or Windows PC management session. The connected app tools do not expose Cashfree merchant orders or the client's local Windows spooler.

A further read-only Render Staging check at `2026-11-19T13:35:14.379208Z` confirmed:
- `printgo_staging` remains the database target.
- `PrintJob`: 9 rows, all `COMPLETED`; no other job statuses.
- `Payment`: 9 rows, all `SUCCESS`.
- `PaymentEvent`: no rows.
- `Refund`: no rows.
- Render service metadata still reports `maintenanceMode.enabled=true`.
- Auto-deploy is still enabled on `feature/printgo-production-readiness`; pre-deploy remains `npx prisma migrate deploy`.

This closes the operator-confirmation portion of the checklist, subject to the normal release-window recheck. It does not independently prove that an external Cashfree callback cannot arrive later or inspect the client's Windows queue.

### Remaining hard blockers
1. Capture the exact PITR recovery status / `startsAt` for `printgo-db-staging` from Render Recovery (or its authenticated recovery API). Do not infer the actual window only from the plan.
2. Resolve the watched-branch auto-deploy risk before any candidate merge. All implementation PRs #9–#15 and documentation/candidate PRs #16–#18 were still Draft and unmerged at the last GitHub inspection. No submitted reviews were returned.
3. Obtain explicit release approval for the exact integrated candidate SHA and the ordered migration/deploy steps. The exact candidate's `prisma migrate status` against Staging is still not evidenced.
4. Repeat the final DB/payment checks at the immediate pre-migration point within the approved window.

**Decision:** keep Maintenance Mode enabled. The observed jobs/payments and operator confirmations are clear, but Staging migration/deploy and public reopening are still NOT AUTHORIZED. Production remains untouched.


## Render Recovery screenshot evidence — 2026-11-19

The operator supplied a screenshot of the Render Recovery page for `printgo-db-staging` (`dpg-dbqn7pifngtc7384j0hg-a`).

Visible screenshot evidence:
- Point-in-Time Recovery section states that the database can be restored from any timestamp in the past 3 days.
- The page offers an upgrade to a Pro workspace to increase the recovery window to 7 days.
- Export section states that database export files are retained for at least 7 days.
- The export list shows:
  - November 19, 2026 at 5:29 PM
  - November 18, 2026 at 11:24 PM
- The newest 5:29 PM export is the same logical export previously downloaded as `2026-11-19T11_59Z.dir.tar.gz`, whose local PostgreSQL 18.7 restore and verification passed.

Official Render documentation corroborates the screenshot: Hobby workspace PITR is 3 days; Pro or higher is 7 days; upgrading does not retroactively backfill earlier PITR history. Logical exports are retained for 7 days. References:
- https://render.com/docs/postgresql-backups
- https://api-docs.render.com/reference/retrieve-postgres-recovery-info

**Exact Recovery API value not captured:** the screenshot shows the 3-day window but does not show the precise `recoveryStatus` or `startsAt` timestamp. Render's documented read-only endpoint `GET /v1/postgres/{postgresId}/recovery` returns `recoveryStatus` and `startsAt`. The connected Render app tools expose Postgres metadata and read-only SQL but not this Recovery endpoint. Do not invent an exact start time from the screenshot.

This is enough to evidence that PITR is presented as available for the past 3 days and that the latest logical export exists and passed a separate isolated restore drill. If a precise recovery boundary is required, capture the API's `recoveryStatus=AVAILABLE` and `startsAt` or the corresponding exact timestamp exposed in the UI.

### Updated gate
- Backup/export + isolated restore verification: PASS.
- Screenshot evidence of 3-day PITR and >=7-day export retention: PASS.
- Exact PITR `recoveryStatus` / `startsAt`: not captured; remains an optional precision evidence item, not inferred.
- Staging migration/deploy: still NOT AUTHORIZED until the auto-deploy/branch collision and final candidate approval are resolved.


## Required Staging Auto-Deploy containment — next operator action

**Current observed setting:** Render backend `printgo-backend-staging` has `autoDeploy=yes`, `autoDeployTrigger=commit`, linked branch `feature/printgo-production-readiness`, and pre-deploy command `npx prisma migrate deploy`.

Before merging any implementation PR or candidate PR into the linked branch:
1. Open the exact Render web service `printgo-backend-staging` → **Settings**.
2. Find **Auto-Deploy** in the Build & Deploy settings section.
3. Select **Off** (not **After CI Checks Pass**) and save the change.
4. Refresh the service Settings page and verify Auto-Deploy displays Off.
5. Re-fetch service metadata / service Deploys + Events and capture evidence that `autoDeploy` is false or `autoDeployTrigger=off`. Do not merge until this is verified.

Why Off rather than After CI Checks Pass: the candidate CI already passes. A successful CI check would therefore allow a deploy after a merge, defeating the need for a manually approved migration window. Off retains manual deploy capability and prevents intermediate stacked-PR merges from automatically deploying.

Official Render instructions: https://render.com/docs/deploys (Settings → Auto-Deploy; Off disables automatic deploys; manual deploys remain available). The checked-in `render.yaml` / Blueprint is not being synced to this existing service as part of this step; do not use Blueprint approval as a substitute for this service-level setting.

**Current state remains unchanged until operator action:** the connected Render tool set does not expose an update-service / Auto-Deploy toggle action. No setting change was made by this runbook update. Once the operator sets Off in the Dashboard, re-read Render metadata to verify before considering any merge.


## Auto-Deploy disabled — verified on Render — 2026-11-19

The operator changed the Render service setting, and the connected Render service metadata independently confirms:
- Service: `printgo-backend-staging` (`srv-dbqpapon74is73csbc80`)
- `autoDeploy=no`
- `autoDeployTrigger=off`
- Linked branch remains `feature/printgo-production-readiness`
- Pre-deploy command remains `npx prisma migrate deploy`
- Maintenance Mode remains `enabled=true`

Render event history records:
- Event type: `auto_deploy_disabled`
- Event ID: `evt-dbvg10jm8hqs739sn640`
- Timestamp: `2026-11-19T13:58:26.361858Z`
- Details: `fromTrigger=commit`, `reason=setting_change`

The latest listed deployment remains commit `cb4859550276bc73f1d4d3c07fc9fe011560878e`, finished `2026-11-18T23:30:33.061216Z`; the Events response after the setting change showed only `auto_deploy_disabled`, not a new deploy. Thus Auto-Deploy has been disabled without triggering a deployment.

This closes the **automatic deployment containment** gate. It does not disable the configured pre-deploy migration command: any later manual deployment of the current service will still run `npx prisma migrate deploy`. A manual deploy must therefore happen only after explicit approval of the exact integrated candidate and migration sequence.

### Candidate dependency note
PR #18 is still Draft/unmerged and is based on `feature/printgo-production-readiness`; its changed files include migrations 00012–00016 plus backend/frontend/Agent implementation. PR #17 is a separate Draft/unmerged PR changing only `render.yaml` and `.github/workflows/ci.yml`; it is not part of PR #18's candidate branch. The PR #17 `render.yaml` explicitly labels itself as a legacy standalone Blueprint and warns it does not describe the live Staging service. Do not sync that Blueprint into the current workspace as a shortcut for this rollout.

### Next required release review
- Have the complete stacked implementation reviewed (PRs #9–#15 and candidate #18; currently Draft/unmerged, no submitted reviews returned on last inspection).
- Keep the PR #17 Blueprint change separate; do not apply it to live Render as part of the Staging migration.
- Obtain exact candidate release approval and record the exact commit SHA.
- Run `npx prisma migrate status` against the confirmed Staging database from the approved candidate using a trusted secret context (never expose DATABASE_URL in chat/log output).
- Recheck the DB preflight immediately before migration and manually trigger the approved deploy only after the release operator authorizes it.

**Decision:** Auto-Deploy containment PASS. Maintenance Mode stays ON. Staging migration/deploy and reopening are still NOT AUTHORIZED. Production remains untouched.
