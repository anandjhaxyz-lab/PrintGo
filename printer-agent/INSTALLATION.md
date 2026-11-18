# PrintGo Printer Agent — Installation & Operational Guide

## Overview
The PrintGo Printer Agent runs on the kiosk or college PC hardware, communicates with the cloud backend via WebSocket, manages hardware-level End-to-End Encryption (E2EE) keys, polls the Windows Print Spooler, and persists crash-durable print job state in a local append journal.

---

## Standard Fresh Installation Sequence

To install and commission the PrintGo Agent on a clean Windows machine:

### 1. Install Dependencies
Open an Administrator PowerShell or Command Prompt:
```cmd
cd C:\PrintGo\printer-agent
npm install
```

### 2. Run Dedicated Provisioning Once
Run `provision_agent.bat` to initialize the installation marker and crash-durable journal:
```cmd
provision_agent.bat
```
This performs a genuine first-time provisioning:
- Generates a cryptographically random UUID for `installationId`.
- Records the ISO `provisionedAt` timestamp in `data\.installation_marker`.
- Creates a clean, empty `data\jobs.journal.json` with schema version 1.
- Leaves PM2 untouched.

### 3. Verify Journal and Installation Marker
Ensure both identity files were created:
```cmd
dir data\
REM Expected output contains:
REM   .installation_marker
REM   jobs.journal.json
```

### 4. Start Agent Normally Using PM2
Launch the agent under PM2 process management without any provisioning flags:
```cmd
pm2 start index.js --name "PrintGo_Agent" --restart-delay 5000 --max-restarts 100
pm2-startup install
pm2 save
```
> **CRITICAL INVARIANT:** Normal PM2 startup must **never** include `--provision` or `--force-reprovision`. The agent reads its existing marker and journal on boot.

### 5. Verify Backend Registration & Printer Connectivity
Inspect the agent logs:
```cmd
pm2 logs PrintGo_Agent --lines 50
```
Verify:
- `✅ Keys loaded from disk` (or newly generated RSA keypair).
- `✅ Validated local Windows printer: <PRINTER_NAME>`.
- `✅ Connected to cloud backend!`.
- `✅ Registration Success. Machine: <MACHINE_NAME>`.

---

## Over-The-Air (OTA) Updates

- Automated updates are triggered via the Windows Scheduled Task `PrintGo_OTA_Updater`.
- The task runs `update_agent.bat` -> `node updater.js`.
- Updates checkout the backend-pinned Git commit, run `npm install --production`, and restart the PM2 process:
  ```javascript
  execSync('pm2 restart PrintGo_Agent', { stdio: 'inherit' });
  ```
- **Durability Guarantee:** PM2 restarts the Agent using its existing process definition (unprovisioned). The existing `.installation_marker` and `jobs.journal.json` are fully preserved.

---

## Protection Against Accidental Overwrite

- If `provision_agent.bat` is executed on an already-provisioned machine:
  - It detects the existing journal and installation marker.
  - It **strictly refuses** to provision and halts with code 1.
  - Customer job history and marker UUID are untouched.
- If an existing machine has its journal accidentally deleted or corrupted:
  - Normal startup fails closed (`isCorrupted = true`).
  - Standard provisioning is blocked to prevent silent loss of in-flight print status.

> [!WARNING]
> **No Manual Deletion of State Files:**
> Operators must never manually delete `data\.installation_marker`, `data\jobs.journal.json`, or `keys\private.pem` without a formal decommissioning procedure, verified backup, and explicit operator authorization. Deleting state files triggers an inconsistent identity halt and prevents automatic reconciliation.

---

## Authorized Force-Reprovision Procedure

In catastrophic scenarios where an existing machine's journal was destroyed and the operator has verified that all physical prints are accounted for:

1. **Stop the Agent:**
   ```cmd
   pm2 stop PrintGo_Agent
   ```
2. **Reconcile Queue & Clear Hardware Tray:**
   - Check the physical printer output tray and clear any printed papers.
   - In the PrintGo Admin Dashboard, mark any stuck `PRINTING` jobs for this machine as resolved or canceled.
3. **Execute Authorized Force-Reprovision:**
   ```cmd
   provision_agent.bat --force-reprovision
   ```
   - The operator is presented with a destructive warning and must type `YES` to confirm.
   - Casual `--force` and non-interactive `--confirm` bypasses are strictly rejected.
   - Automatic execution from PM2, setup scripts, CI or OTA updater is blocked.
4. **Restart the Agent:**
   ```cmd
   pm2 start PrintGo_Agent
   ```
