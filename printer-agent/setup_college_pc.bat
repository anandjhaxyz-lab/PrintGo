@echo off
setlocal EnableDelayedExpansion
echo ==============================================
echo Step 1: Installing PrintGo Agent Dependencies...
echo ==============================================
call npm install

echo.
echo ==============================================
echo Installing PM2 (Process Manager)...
echo ==============================================
call npm install -g pm2
call npm install -g pm2-windows-startup

echo.
echo ==============================================
echo Step 2: Installation Verification and Provisioning...
echo ==============================================

REM Check all identity anchors on disk
set "MARKER_EXISTS=0"
set "JOURNAL_EXISTS=0"
set "KEY_EXISTS=0"

if exist "%~dp0data\.installation_marker" set "MARKER_EXISTS=1"
if exist "%~dp0data\jobs.journal.json" set "JOURNAL_EXISTS=1"
if exist "%~dp0keys\private.pem" set "KEY_EXISTS=1"

REM Scenario A: Fully provisioned and healthy installation
if "!MARKER_EXISTS!"=="1" if "!JOURNAL_EXISTS!"=="1" (
    echo [INFO] Agent is already fully provisioned - marker and journal present.
    goto step2_verified
)

REM Scenario B: Inconsistent or partially wiped existing installation
if "!JOURNAL_EXISTS!"=="1" goto inconsistent_identity
if "!KEY_EXISTS!"=="1" goto inconsistent_identity
if "!MARKER_EXISTS!"=="1" goto inconsistent_identity

REM Scenario C: Genuine fresh installation (none of marker, journal, keys exist)
echo ==============================================================
echo  NEW AGENT COMMISSIONING
echo ==============================================================
echo No existing installation identity was detected on this machine.
echo This PC will be commissioned as a NEW PrintGo Agent.
echo.
set "COMMISSION_CONFIRM="
set /p COMMISSION_CONFIRM="Do you want to commission a new Agent identity on this PC? (Type 'YES' to confirm): "
if not "!COMMISSION_CONFIRM!"=="YES" (
    echo.
    echo [ABORTED] Commissioning cancelled by operator.
    echo No changes were made.
    exit /b 1
)

echo.
echo Initializing fresh agent provisioning...
call "%~dp0provision_agent.bat"
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Provisioning failed! Cannot proceed with unprovisioned agent.
    exit /b 1
)

:step2_verified
REM Verify journal and installation marker exist
if not exist "%~dp0data\.installation_marker" (
    echo [ERROR] Installation marker missing! Cannot start agent without provisioning.
    exit /b 1
)
if not exist "%~dp0data\jobs.journal.json" (
    echo [ERROR] Journal file missing! Cannot start agent without valid journal.
    exit /b 1
)
goto step3_configure_pm2

:inconsistent_identity
echo ==============================================================
echo [CRITICAL ERROR] INCONSISTENT INSTALLATION STATE DETECTED!
echo ==============================================================
echo Existing identity evidence was found on this machine:
if "!JOURNAL_EXISTS!"=="1" echo   - jobs.journal.json is present (existing job history)
if "!KEY_EXISTS!"=="1"     echo   - keys\private.pem is present (existing E2EE identity)
if "!MARKER_EXISTS!"=="1"  echo   - .installation_marker is present
if "!MARKER_EXISTS!"=="0"  echo   - .installation_marker is MISSING
if "!JOURNAL_EXISTS!"=="0" echo   - jobs.journal.json is MISSING
echo.
echo To prevent duplicate physical prints or loss of in-flight jobs,
echo automatic fresh provisioning is STRICTLY REFUSED.
echo.
echo RECOVERY INSTRUCTIONS:
echo   1. If this is an existing machine recovering from an outage:
echo      - Clear the physical printer output tray.
echo      - Reconcile all outstanding jobs in the PrintGo Admin Dashboard.
echo      - Stop PM2: pm2 stop PrintGo_Agent
echo      - Run: provision_agent.bat --force-reprovision
echo   2. If this machine is being decommissioned or permanently repurposed:
echo      - Follow the authorized decommissioning SOP (create verified backup and archive keys).
echo      - Never manually delete data or keys without formal authorization and backup.
echo      - Use provision_agent.bat --force-reprovision only after completing reconciliation.
echo ==============================================================
exit /b 1

:step3_configure_pm2
echo.
echo ==============================================
echo Step 3: Configuring PM2 to start on Windows Boot...
echo ==============================================
call pm2-startup install

echo.
echo ==============================================
echo Step 4: Starting PrintGo Agent Normally...
echo ==============================================
call pm2 start index.js --name "PrintGo_Agent"

echo.
echo ==============================================
echo Step 5: Saving PM2 Configuration...
echo ==============================================
call pm2 save

echo.
echo ==============================================
echo Setup Complete! The PrintGo Agent is now running
echo in the background and will auto-start on boot.
echo ==============================================
pause
