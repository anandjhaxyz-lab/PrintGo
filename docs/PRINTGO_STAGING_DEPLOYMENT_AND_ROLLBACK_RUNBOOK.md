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

Latest live Staging frontend deploys observed during this review:
- Admin Staging: commit 2828ea390c0c3285b79fb2fdf3e3b335d7537a97.
- Customer Staging: commit bc915bd18454bec2359f7a1d8b7a01bbd0f382f2.

These differ from the latest live Staging backend commit cb4859550276bc73f1d4d3c07fc9fe011560878e. They are currently live on the same tracked feature/printgo-production-readiness branch, but they are not the multi-printer candidate. After the code stack is approved, deploy both Staging frontends from the same reviewed integrated release candidate as the backend; do not assume the three service SHAs automatically match.

### Staging data services

Read-only Render inventory showed:
- PostgreSQL: printgo-db-staging, database printgo_staging, PostgreSQL 18, 1 GB disk, Singapore, status available.
- Redis: printgo-staging-redis, 256 MB, Singapore, status available.

Production has separate PostgreSQL (printgo-production-db) and Redis (printgo-production-redis) resources. Never point Staging services at Production data services or credentials.

## 2. Verified database migration baseline

A read-only query of Staging's Prisma migration ledger showed the newest successfully applied migration as:

20261118000011_add_cash_payment_mode_and_confirmation

The ledger currently contains migrations through 20261118000011. The stacked multi-printer PR chain includes these later migrations:

1. 20261119000012_add_printer_devices — PR #9
2. 20261119000013_printer_discovery_approval — PR #12
3. 20261119000014_printer_device_qr_uniqueness — PR #13
4. 20261119000015_printer_device_dispatch_leases — PR #15
5. 20261119000016_print_job_queue_snapshot — PR #15

None of migrations 00012–00016 appeared in the inspected Staging migration ledger. PRs #9–#13 and #15 are open Draft PRs and form the active code dependency chain; PR #14 is closed and is not part of the candidate. Before any migration, run npx prisma migrate status against the confirmed Staging database using the exact reviewed and integrated release candidate. Verify the complete pending set, including any other migration directories in that candidate; Prisma must apply every pending migration in timestamp order.

The current CI workflow applies migrations to a disposable PostgreSQL 15 database. The inspected Render Staging database is PostgreSQL 18. The Staging migration execution must therefore be treated as a separate environment gate; CI success alone does not establish that the live Staging database has been migrated.

## 3. Configuration discrepancies and deployment blockers

### 3.1 Root render.yaml is a legacy standalone Blueprint, not the live Staging service configuration

The live Render Staging backend was inspected directly. Its service configuration is:
- Build: npm install && npx prisma generate
- Pre-deploy: npx prisma migrate deploy
- Start: npm start
- Health check: /api/health

The Staging service logs on 18 November 2026 explicitly show:
- Using Node.js version 24.22.1 (default)
- Starting pre-deploy: npx prisma migrate deploy

Therefore, the live Staging service already uses Node 24.22.1 and Prisma migration deployment. Do not change those live settings merely to resolve a repository-template discrepancy.

The root render.yaml originally declared Node 18 and used prisma db push. It also defines resource names printgo-backend, printgo-db and printgo-redis, which do not match the current live resource names printgo-backend-staging / printgo-backend-production, printgo-db-staging / printgo-production-db, and their separately provisioned Redis services. It is therefore a legacy standalone Blueprint template, not a safe representation of the existing Staging/Production service graph.

Draft PR #17 proposes to correct that standalone template to Node 24.22.1, npm ci, and preDeployCommand: npx prisma migrate deploy, aligns backend CI from Node 20.x to Node 24.x, uses the Key Value connectionString reference, and adds the required empty ipAllowList for that test-only Key Value resource. CI run #44502424580 passed on earlier branch commit 8fcc40b42122e4486db08ea00b9c64158e8d3cea. Two later commits (303f2f2 and 40dd141) made Blueprint-only Key Value reference/IP-list changes; final YAML syntax and expected structure were checked locally with PyYAML. Render's own Blueprint validation was not run. PR #17 remains Draft, and the final Blueprint changes still require Render-side validation before any use. It does not sync or update the live Render resources.

**Do not sync the root render.yaml into the current Render workspace.** Render applies Blueprint configuration to matching named resources and can provision resources defined by the Blueprint; the existing names and ownership must be reconciled in a separate infrastructure review first. Do not use prisma db push for this release; retain the live Staging migration-ledger workflow.

Official references: https://render.com/docs/blueprint-spec and https://render.com/docs/node-version

### 3.2 Staging auto-deploy branch

The live Staging backend currently auto-deploys on commits to feature/printgo-production-readiness. The multi-printer code is held in stacked feature branches and is not the currently deployed Staging commit.

**Critical merge interaction:** PR #9 currently targets feature/printgo-production-readiness, which is the exact branch watched by the live Staging backend with auto-deploy enabled. Merging PR #9 as it is currently targeted will therefore trigger a Staging backend deployment of the partially integrated stack. Do not merge PR #9 until the deployment path has been deliberately isolated or the Staging auto-deploy behavior has been explicitly controlled and approved.

Before any code merge or release candidate is placed on a branch watched by Staging:
- Review the exact target branch and commit SHA.
- Prevent an unintended partial deploy by either using an isolated integration/release branch not watched by Render, or explicitly disabling Staging auto-deploy before the first stacked merge and later performing one reviewed manual deploy.
- Obtain explicit release approval before changing branch settings, auto-deploy settings, or pushing to the watched branch.
- Do not assume a Draft PR merge is harmless just because the migration is additive.
- Do not use the Production branch or Production services as a shortcut.

Production backend also auto-deploys on commits to fix/p1-production-blockers. Never push the multi-printer candidate to that branch as part of Staging testing.

## 4. Pre-deployment authorization gates

Do not start the deployment until every applicable gate is checked:

- [ ] PRs #9, #10, #11, #12, #13 and #15 are reviewed and approved in dependency order; merge only when explicitly authorized.
- [ ] The exact stacked code merge chain is #9 -> #10 -> #11 -> #12 -> #13 -> #15; verify each PR base/head and CI after each dependency is integrated.
- [ ] PR #17 (Render Blueprint / backend CI alignment) is reviewed separately; its Node 24 backend CI must pass on the exact head SHA before approval. It is based on PR #15 and does not alter live Render resources.
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

1. **Freeze the candidate.** Record the reviewed PR head SHAs and the intended integrated release SHA. Confirm code PR merge order #9 -> #10 -> #11 -> #12 -> #13 -> #15. Review PRs #16 and #17 separately after the code stack; do not treat a Draft PR as merge authorization. Keep Production branches and services untouched.
2. **Prepare the Staging deployment target before merging anything.** In Render, re-confirm printgo-backend-staging, its Staging URL, branch, build command, pre-deploy command, start command and health check. Explicitly prevent an unintended partial deployment from the current auto-deploy-on-commit setting. PR #9 currently targets the watched Staging branch, so merging it as-is will trigger a Staging deploy. Use an isolated integration/release branch or explicitly disable Staging auto-deploy before the first merge. Do not change a service branch or auto-deploy setting without approval.
3. **Integrate the reviewed code stack only after the deployment path is isolated.** Merge PRs #9 -> #10 -> #11 -> #12 -> #13 -> #15 in dependency order, reviewing each resulting base/head, commit SHA and CI result before proceeding. Do not merge a later stacked PR against a stale base. Review PRs #16 and #17 as sidecar documentation/configuration changes after the code chain.
4. **Take and verify a Staging database backup.** Confirm the backup belongs to printgo_staging, not printgo-production_db. Record the backup identifier and timestamp in the release evidence.
5. **Validate migration state.** Run npx prisma migrate status with the final integrated candidate's backend/prisma directory and the confirmed Staging DATABASE_URL. Compare the pending list with all migration directories in the candidate, including 00012–00016. Stop on drift, failed migrations, unexpected applied migrations, or any database target ambiguity.
6. **Deploy the backend candidate to Staging.** Use the Render deployment flow approved for the exact release SHA. The configured pre-deploy command is npx prisma migrate deploy; verify that the migration step succeeds before accepting the new backend. Do not run prisma db push.
7. **Verify backend readiness.** Check /api/health for process liveness and /api/ready for database, Redis, print queue, upload worker, upload queue events and (when enabled) Socket.IO Redis adapter readiness. /api/health is liveness only; require /api/ready to report ready with HTTP 200 before functional tests.
8. **Deploy matching Admin and Customer Staging frontends.** Because the current Staging frontend services have auto-deploy disabled, deploy each manually from the same approved release candidate. Check that both use the Staging backend API URL, not Production.
9. **Keep the feature flag disabled for baseline smoke checks.** Verify login, Admin overview, Machine health, legacy Machine QR flow, customer page load and existing single-printer behavior. Confirm no Production customer, payment or data path is involved.
10. **Install the matching reviewed Windows x64 Agent on the client PC** only after the client window is available and the installation is explicitly approved. Confirm Machine registration, handshake, fresh registry, discovery and Admin approval.
11. **Enable ENABLE_MULTI_PRINTER_DISPATCH in Staging only** after all prior checks pass and the operator is ready to run the Hyderabad physical certification checklist. Recheck the exact service name before the environment change, then restart/redeploy only the Staging backend as required.
12. **Run the Hyderabad certification checklist** at docs/HYDERABAD_WINDOWS_PHYSICAL_CERTIFICATION_CHECKLIST.md. Capture evidence for each test. Do not treat CI, a healthy Agent heartbeat, or a QR resolving successfully as proof of a physical print.

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

**Current decision:** NOT READY TO DEPLOY. PRs #9–#15 remain Draft and unmerged. PR #16 is the documentation Draft. PR #17 proposes the legacy Blueprint / backend CI alignment. CI run #44502424580 passed on commit 8fcc40b; later Blueprint-only commits 303f2f2 and 40dd141 passed local YAML parsing but do not have a fresh CI run or Render Blueprint validation. The Draft PR still requires review and validation. The Staging Admin and Customer frontends are also deployed at different SHAs from the backend, so all three must be aligned to the approved release candidate before functional rollout. The Staging migration ledger is applied through 00011, while multi-printer migrations 00012–00016 are pending. The live Staging backend currently reports Node 24.22.1 and uses migrate deploy; its tracked branch is still separate from the multi-printer feature stack. The client Windows PC is currently unavailable/offline. No deployment, migration or Render environment change has been performed by this runbook.


## 9. Staging Postgres backup and restore drill (Windows operator procedure)

**Do not merge/deploy/migrate until this drill is complete and the evidence is recorded.** This runbook section is specific to the current Staging DB inventory snapshot from 2026-11-19:
- Render resource: `printgo-db-staging` / `dpg-dbqn7pifngtc7384j0hg-a`.
- Database: `printgo_staging`.
- Server: PostgreSQL 18.6.
- Render compute plan: `0.1c-256mb` (legacy Basic-256 MB paid compute plan, not the `free` plan).
- Configured disk: 1 GB.

The current Render compute-plan documentation distinguishes `free` from the paid legacy plan `0.1c-256mb`. Paid Postgres supports PITR and on-demand logical exports; the Recovery page is the authority for the database's current state and workspace-tier PITR window. Render retains on-demand logical exports for 7 days, so download the file before relying on it as an off-platform backup. See https://render.com/docs/compute-plans and https://render.com/docs/postgresql-backups.

### A. Create and download the logical export

1. Open the exact Staging database resource in Render and select **Recovery**: https://dashboard.render.com/d/dpg-dbqn7pifngtc7384j0hg-a
2. Confirm the page identifies `printgo-db-staging` and database `printgo_staging`; do not use the Production database.
3. Note the PITR section and its earliest/latest available recovery timestamps. Capture the currently available restore window (workspace plan determines the window: 3 days on Hobby, 7 days on Pro-or-higher).
4. Select **Create export**. Do not start a second export while one is in progress.
5. Wait until the export is complete, then download the `.dir.tar.gz` archive. Do not rely only on Render's 7-day retained copy.
6. Store the archive in access-controlled backup storage. Do not add it to GitHub, email it, or paste any connection string/password into chat.
7. In PowerShell, record SHA-256 and file size:
   ```powershell
   $Backup = "D:\PrintGoBackups\printgo_staging_YYYY-MM-DDTHH_mmZ.dir.tar.gz"
   Get-Item $Backup | Select-Object FullName, Length, LastWriteTimeUtc
   Get-FileHash $Backup -Algorithm SHA256
   ```

### B. Verify archive structure before restoring

1. Use PostgreSQL 18 client tools for this PostgreSQL 18.6 source (Render recommends matching the major client-tool version).
2. Confirm `pg_restore --version` reports major version 18.
3. Extract the archive into a new empty folder; do not extract over an earlier drill:
   ```powershell
   $Extract = "D:\PrintGoBackups\restore-drill-YYYYMMDD"
   New-Item -ItemType Directory -Force -Path $Extract | Out-Null
   tar -xzf $Backup -C $Extract
   Get-ChildItem $Extract -Recurse -Filter toc.dat
   ```
4. The folder containing `toc.dat` is the directory-format archive root. Set it explicitly:
   ```powershell
   $DumpDir = (Get-ChildItem $Extract -Recurse -Filter toc.dat | Select-Object -First 1).Directory.FullName
   if (-not $DumpDir) { throw "Archive TOC not found; do not restore this file." }
   pg_restore --list $DumpDir | Out-File "$Extract\archive-contents.txt" -Encoding utf8
   ```
5. Check the contents listing for the expected application tables and `_prisma_migrations`. A successful listing is an archive-structure check, not yet proof of a successful restore.

### C. Restore only into a separate empty, non-production PostgreSQL 18 database

- Preferred destination: a dedicated local PostgreSQL 18 restore-drill instance/database on a separate port, or an explicitly approved temporary non-production PostgreSQL 18 database. Do not restore over the live Staging DB.
- Do not use the existing PostgreSQL 16 installation as the restore destination for a PostgreSQL 18 dump unless PostgreSQL compatibility has separately been proven. Use matching PostgreSQL 18 server/client tools.
- Creating a new Render database can incur ongoing charges. Do not create a cloud database for the drill without explicit cost approval.
- Create a new empty database first (for example, `printgo_staging_restore_drill`). Never point the restore at a database with data that must be preserved.
- Use the target's connection string locally, not in Git or chat. For a Render target, obtain its external database URL from the target resource's Info page. Use a local target when possible to avoid extra cloud resource cost.
- Restore the archive directory using the following pattern after replacing the local target host/port/credentials:
  ```powershell
  $Target = "postgresql://postgres:<LOCAL_PASSWORD>@127.0.0.1:5433/printgo_staging_restore_drill"
  pg_restore --dbname=$Target --format=directory --verbose --no-owner --no-privileges $DumpDir
  if ($LASTEXITCODE -ne 0) { throw "Restore failed; keep Staging unchanged and investigate." }
  ```
  Do not add `--clean` or `--if-exists` to the first restore into an empty drill DB. Those options drop matching destination objects.
- Keep the target connection string local and remove it from the PowerShell session when finished:
  ```powershell
  Remove-Variable Target -ErrorAction SilentlyContinue
  ```

### D. Verify the restored database

On the separate restored database, run read-only checks and compare with the recorded pre-export Staging snapshot:
```sql
SELECT current_database(), version(), pg_size_pretty(pg_database_size(current_database()));
SELECT migration_name, finished_at, rolled_back_at
FROM public."_prisma_migrations"
ORDER BY started_at;
SELECT 'Machine' AS table_name, count(*)::bigint AS row_count FROM public."Machine"
UNION ALL SELECT 'PrinterQr', count(*) FROM public."PrinterQr"
UNION ALL SELECT 'Session', count(*) FROM public."Session"
UNION ALL SELECT 'PrintJob', count(*) FROM public."PrintJob"
UNION ALL SELECT 'PrinterStatus', count(*) FROM public."PrinterStatus"
ORDER BY table_name;
```
Expected pre-export reference counts from the 2026-11-19 read-only Staging snapshot: Machine 1; PrinterQr 1; Session 84; PrintJob 9; PrinterStatus 3,957. These counts can differ if new legitimate Staging activity occurred between the snapshot and export; compare with the actual export-time snapshot, not blindly with the older numbers.
Also verify that the restored `_prisma_migrations` ledger ends at the expected latest applied migration, table definitions/indexes are present, and sample records can be read. Record the restore output, archive SHA-256, target PostgreSQL version, verification timestamp and operator. Only then mark backup/restore readiness complete.

### E. PITR notes

PITR is not the same as a logical export. Render PITR recovery creates a new database instance at the selected historical time; it does not overwrite the original. The new recovery database is billable while it exists. Do not initiate PITR as part of this migration preflight; use it only for an approved recovery exercise or actual recovery. Review the Recovery page's current eligible time range before depending on PITR.

## 10. Live schema compatibility follow-up (read-only, 2026-11-19)

A second schema inspection confirmed the existing Staging columns used by migration 00012 are present in Machine, PrinterQr, Session, PrintJob and PrinterStatus. Existing Machine/QR/session/job/telemetry foreign keys and their delete actions are present. PostgreSQL 18.6 resolves `gen_random_uuid()` even though pgcrypto is not installed. The existing legacy active-per-Machine QR index is present and target multi-printer objects remain absent.

The only Machine has a known printer model `EPSON L6460 Series` but its `connectionType` is NULL. Migration 00012 will preserve that NULL. Do not infer a Windows spooler queue name or connection type from the model; obtain it through Agent discovery and explicit Admin approval later.

Session expiry check at 2026-11-19 11:33 UTC: all 84 Session rows had `expiresAt <= now()`, even though 5 were labelled `CONNECTED` and 75 `WAITING_FOR_MOBILE`. No row was unexpired. Migration 00012 does not alter session status. The Staging smoke-test owner must ensure expired sessions are not shown as live after deployment; do not mass-update historical Session statuses as part of migration preparation without separate approval.

All database checks in this section were read-only. No service setting, DB data, backup, restore, migration or deployment was changed.
