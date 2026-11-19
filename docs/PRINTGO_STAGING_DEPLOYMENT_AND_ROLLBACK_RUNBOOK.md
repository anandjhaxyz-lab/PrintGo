# PrintGo — Staging Deployment and Rollback Runbook

**Review date:** 19 November 2026  
**Purpose:** Controlled Staging rollout of the multi-printer feature after code review and physical-readiness gates.  
**Status:** RUNBOOK ONLY — no deployment, migration, branch switch, environment-variable change, or feature-flag change has been performed.

## 1. Current live deployment inventory (read-only inspection)

The following values were inspected from the connected Render workspace. They are an inventory snapshot, not instructions to modify services.

### Backend services

| Environment | Render service | Current tracked branch | Auto-deploy | Build / pre-deploy / start | Health path |
|---|---|---|---|---|---|
| Staging | printgo-backend-staging (srv-dbqpapon74is73csbc80) | feature/printgo-production-readiness | Yes — on commit | npm install && npx prisma generate / npx prisma migrate deploy / npm start | /api/health |
| Production | printgo-backend-production (srv-dbs3hlk9v7es73bje5hg) | fix/p1-production-blockers | Yes — on commit | npm install && npx prisma generate / npx prisma migrate deploy / npm start | /api/health |

Both backends use the backend root directory and Singapore region. Staging uses one 0.5c-512mb instance with a 1 GB disk mounted at /var/data. Production uses one Starter instance with a 1 GB uploads disk mounted at /opt/render/project/src/backend/uploads.

Latest live backend deployment observed during this review:
- Staging: commit cb4859550276bc73f1d4d3c07fc9fe011560878e.
- Production: commit bb8cbf3790a2ee48662a69830aba1531af946569.

These are not the multi-printer feature candidate commits.

### Frontend services

| Environment | Render service | Current tracked branch | Auto-deploy | Build | Publish directory |
|---|---|---|---|---|---|
| Admin Staging | printgo-admin-staging (srv-dbr1p9dbedkc738mbk10) | feature/printgo-production-readiness | No | npm install && npm run build | dist (root frontend/) |
| Customer Staging | printgo-customer-staging (srv-dbtjubjbc2fs73bud4ig) | feature/printgo-production-readiness | No | cd frontend && npm install && npm run build | frontend/dist |
| Admin Production | printgo-frontend-production (srv-dbs3hlk9v7es73bje5h0) | fix/p1-production-blockers | Yes — on commit | npm install && npm run build | ./dist (root frontend/) |

Staging frontend deploys are manual in the currently configured Render services. Confirm the selected frontend commit matches the backend release candidate before deploying either frontend.

### Staging data services

Read-only Render inventory showed:
- PostgreSQL: printgo-db-staging, database printgo_staging, PostgreSQL 18, 1 GB disk, Singapore, status available.
- Redis: printgo-staging-redis, 256 MB, Singapore, status available.

Production has separate PostgreSQL (printgo-production-db) and Redis (printgo-production-redis) resources. Never point Staging services at Production data services or credentials.

## 2. Verified database migration baseline

A read-only query of Staging's Prisma migration ledger showed the newest successfully applied migration as:

20261118000011_add_cash_payment_mode_and_confirmation

The ledger currently contains migrations through 20261118000011. The multi-printer PR stack adds at least these later migrations:

1. 20261119000013_printer_discovery_approval — PR #12
2. 20261119000014_printer_device_qr_uniqueness — PR #13
3. 20261119000015_printer_device_dispatch_leases — PR #15
4. 20261119000016_print_job_queue_snapshot — PR #15

These later migrations were not present in the inspected Staging migration ledger. Before any migration, run npx prisma migrate status against the confirmed Staging database using the exact reviewed release candidate and verify the complete pending migration set. Do not assume the list above is exhaustive; Prisma must apply every pending migration in timestamp order.

The current CI workflow applies migrations to a disposable PostgreSQL 15 database. The inspected Render Staging database is PostgreSQL 18. The Staging migration execution must therefore be treated as a separate environment gate; CI success alone does not establish that the live Staging database has been migrated.

## 3. Configuration discrepancies and deployment blockers

### 3.1 Render Blueprint file is not aligned with live service settings

The checked-in render.yaml on the inspected feature branch currently specifies:
- NODE_VERSION: ~18.0.0
- Build command: npm install && npx prisma generate && npx prisma db push
- Free-plan PostgreSQL and Redis resources.

The live Render Staging backend service instead has:
- Build command: npm install && npx prisma generate
- Pre-deploy command: npx prisma migrate deploy
- Start command: npm start
- Separately provisioned Staging PostgreSQL and Redis resources as listed above.

**Do not deploy or reconfigure the existing Render services from the current render.yaml without a separate reconciliation review.** In particular, prisma db push must not replace the migration-ledger workflow for this release. CI currently tests with Node.js 20, while the Blueprint declares Node.js 18; reconcile the runtime version deliberately and verify it against the exact release candidate. Do not silently change the live service configuration as part of this runbook.

### 3.2 Staging auto-deploy branch

The live Staging backend currently auto-deploys on commits to feature/printgo-production-readiness. The multi-printer code is held in stacked feature branches and is not the currently deployed Staging commit.

Before placing any release candidate on a branch watched by the Staging service:
- Review the exact target branch and commit SHA.
- Account for the current auto-deploy setting. A commit pushed to the watched Staging branch can deploy automatically.
- Obtain explicit release approval before changing branch settings, auto-deploy settings, or pushing to that branch.
- Do not use the Production branch or Production services as a shortcut.

Production backend also auto-deploys on commits to fix/p1-production-blockers. Never push the multi-printer candidate to that branch as part of Staging testing.

## 4. Pre-deployment authorization gates

Do not start the deployment until every applicable gate is checked:

- [ ] PR #12 reviewed and approved; merge only when explicitly authorized.
- [ ] PR #13 reviewed and approved after #12 is integrated; merge only when explicitly authorized.
- [ ] PR #15 reviewed and approved after #13 is integrated; latest code CI must pass for the exact head SHA.
- [ ] PR #16 documentation has been reviewed; it contains the physical certification checklist and this runbook.
- [ ] Exact release candidate SHA is recorded for backend, frontend and Windows Agent. Do not mix artifacts from different commits.
- [ ] Target Render service is positively identified as Staging; read the service name and URL again before every action.
- [ ] Staging PostgreSQL backup / restore point is captured and its availability is verified before migration.
- [ ] Staging Redis is healthy and the backend's required Redis configuration is confirmed without exposing secret values.
- [ ] The Staging DATABASE_URL points to printgo_staging; Redis settings point only to printgo-staging-redis.
- [ ] ENABLE_MULTI_PRINTER_DISPATCH is still off before the new code and migrations are deployed.
- [ ] Cashfree live credentials are not used for the certification. Use the approved Staging Demo Simulation path.
- [ ] The client Windows PC and approved printers are available for the physical certification window.

If any gate is incomplete, stop and record the blocker. Do not merge, deploy, migrate, or enable the flag merely to make the checklist green.

## 5. Controlled Staging release sequence

This section is an operator sequence to use only after the gates above have been approved.

1. **Freeze the candidate.** Record the reviewed PR head SHAs and the final integrated release SHA. Confirm PR merge order #12 -> #13 -> #15. Keep Production branches and services untouched.
2. **Prepare the Staging deployment target.** In Render, re-confirm printgo-backend-staging, its Staging URL, branch, build command, pre-deploy command, start command and health check. Explicitly manage the current auto-deploy-on-commit behavior so the candidate cannot deploy accidentally. Do not change a service branch or auto-deploy setting without approval.
3. **Take and verify a Staging database backup.** Confirm the backup belongs to printgo_staging, not printgo-production_db. Record the backup identifier and timestamp in the release evidence.
4. **Validate migration state.** Run npx prisma migrate status with the candidate's backend/prisma directory and the confirmed Staging DATABASE_URL. Compare the pending list with the migration set included in the reviewed release. Stop on drift, failed migrations, unexpected applied migrations, or any database target ambiguity.
5. **Deploy the backend candidate to Staging.** Use the Render deployment flow approved for the exact release SHA. The configured pre-deploy command is npx prisma migrate deploy; verify that the migration step succeeds before accepting the new backend. Do not run prisma db push.
6. **Verify backend readiness.** Check /api/health for process liveness and /api/ready for database, Redis, print queue, upload worker, upload queue events and (when enabled) Socket.IO Redis adapter readiness. /api/health is liveness only; require /api/ready to report ready with HTTP 200 before functional tests.
7. **Deploy matching Admin and Customer Staging frontends.** Because the current Staging frontend services have auto-deploy disabled, deploy each manually from the same approved release candidate. Check that both use the Staging backend API URL, not Production.
8. **Keep the feature flag disabled for baseline smoke checks.** Verify login, Admin overview, Machine health, legacy Machine QR flow, customer page load and existing single-printer behavior. Confirm no Production customer, payment or data path is involved.
9. **Install the matching reviewed Windows x64 Agent on the client PC** only after the client window is available and the installation is explicitly approved. Confirm Machine registration, handshake, fresh registry, discovery and Admin approval.
10. **Enable ENABLE_MULTI_PRINTER_DISPATCH in Staging only** after all prior checks pass and the operator is ready to run the Hyderabad physical certification checklist. Recheck the exact service name before the environment change, then restart/redeploy only the Staging backend as required.
11. **Run the Hyderabad certification checklist** at docs/HYDERABAD_WINDOWS_PHYSICAL_CERTIFICATION_CHECKLIST.md. Capture evidence for each test. Do not treat CI, a healthy Agent heartbeat, or a QR resolving successfully as proof of a physical print.

## 6. Post-deployment smoke and acceptance

Minimum Staging acceptance:

- [ ] /api/health responds 200 and /api/ready responds 200 with status: ready.
- [ ] Admin and Customer frontends load from their Staging URLs and communicate only with the Staging backend.
- [ ] Backend migration ledger shows all candidate migrations completed; no failed or rolled-back migration rows remain.
- [ ] Staging database and Redis connections are healthy.
- [ ] Agent is ONLINE with fresh heartbeat, Windows x64 protocol negotiation, current registry and fresh device telemetry.
- [ ] Only explicitly approved PrinterDevices are ACTIVE and queue-bound.
- [ ] Each printer's permanent QR resolves to its own Session and PrintJob identity.
- [ ] Physical print tests pass on the intended Windows queue; no wrong-device output, duplicate print, false success, silent fallback or stuck paid job remains.
- [ ] Logs, job IDs, sanitized screenshots and physical output evidence are attached to the release record.
- [ ] Production service branch, deployed SHA, environment variables and database remain unchanged.

## 7. Rollback and incident containment

### Immediate containment

If Staging fails or a wrong-printer / duplicate / ambiguous print is detected:

1. Stop new customer intake for the affected test counter and pause further physical print tests.
2. Preserve Agent journal, Windows spooler evidence, PrintJob IDs, payment/refund state and sanitized backend logs.
3. Do not blindly retry an ambiguous job. Resolve the physical outcome first under the operator-reprint policy.
4. Do not remap or re-enable the affected device until its queue, discovery and any active dispatch lease are checked.
5. Keep Production isolated and unchanged.

### Feature-flag caution

The backend intentionally terminalizes device-bound jobs that are blocked because dispatch is disabled or the device / immutable queue mapping is no longer valid. For a successful payment it attempts an idempotent refund. Therefore, switching ENABLE_MULTI_PRINTER_DISPATCH off while device-bound paid jobs are waiting is **not** a harmless rollback switch.

Before disabling the flag:
- Stop new device-bound customer submissions.
- Inspect queued / claimed / in-flight device-bound jobs and reconcile any ambiguous printer handoff.
- Record which waiting jobs will be cancelled and which successful payments require refund verification.
- Confirm there is no active dispatch lease being mistaken for a completed print.
- Only then change the Staging flag with explicit authorization and verify the resulting job and refund ledger.

### Application rollback

- Prefer redeploying the last known-good Staging backend and frontend deployment for the same environment.
- Before redeploying older application code, confirm it is compatible with the already-applied additive database schema.
- Do not delete migration history, run prisma migrate reset, or automatically reverse SQL migrations.
- If a database restore is required, stop writers and obtain explicit approval acknowledging that restoring a backup can discard transactions written after that backup. Verify the restore target is the Staging database only.
- Re-run /api/ready, the legacy smoke tests and relevant customer/Admin checks before reopening Staging intake.

### Production is a separate release

A Staging pass does not authorize Production deployment. Production rollout requires a separate approval, an explicit Production backup/restore plan, verified migration compatibility, reviewed Production feature-flag plan, matching Agent distribution and controlled rollout/monitoring. Never copy Staging credentials or point Staging code to Production services.

## 8. Stop conditions

Stop and escalate rather than continuing if any of these occur:
- Service name, URL, branch, commit SHA or database target does not match the approved Staging release.
- Migration status differs from the reviewed candidate, a migration fails, or the database backup cannot be verified.
- /api/ready returns 503 or any required dependency is not ready.
- Agent is offline, queue name differs, discovery is stale, PrinterDevice is not approved, or QR/session/job identity mismatches.
- Physical output goes to the wrong printer, is duplicated, or the backend reports success without matching physical evidence.
- A paid job remains stuck, refund state is unclear, or a prior print outcome is ambiguous.
- Any Production resource or Production credential is unexpectedly involved.

**Current decision:** NOT READY TO DEPLOY. The reviewed multi-printer PR stack remains Draft, the Staging database migration ledger is behind the new multi-printer migration set, the Staging deployment branch is separate from the feature branch stack, and the client Windows PC is currently unavailable/offline. No deployment or environment change is authorized by this document.
