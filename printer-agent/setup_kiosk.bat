@echo off
setlocal EnableDelayedExpansion
REM ==============================================================
REM PrintGo Kiosk Lockdown Setup Script
REM ==============================================================
REM Run this script as Administrator on the kiosk PC.
REM It configures:
REM   1. Auto-login for the kiosk user
REM   2. PM2 for process management (auto-restart on crash/boot)
REM   3. Chrome kiosk mode (fullscreen, no address bar)
REM   4. Basic Windows hardening (disable Task Manager hotkeys)
REM ==============================================================

echo.
echo ================================================
echo  PrintGo Kiosk Setup - Step 1: Dependencies
echo ================================================
echo.

REM Install Node.js dependencies for the printer agent
cd /d "%~dp0"
call npm install

REM Install PM2 globally for process management
call npm install -g pm2
call npm install -g pm2-windows-startup

echo.
echo ================================================
echo  PrintGo Kiosk Setup - Step 2: Installation Verification and Provisioning
echo ================================================
echo.

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
REM (e.g. journal or keys exist without marker, or marker exists without journal)
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
goto step3_start_agent

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

:step3_start_agent

echo.
echo ================================================
echo  PrintGo Kiosk Setup - Step 3: Start Agent with PM2
echo ================================================
echo.

REM 4. Start the printer agent normally using PM2 (WITHOUT provisioning flags)
call pm2 start index.js --name "PrintGo_Agent" --restart-delay 5000 --max-restarts 100

REM Configure PM2 to auto-start on Windows boot
call pm2-startup install
call pm2 save

echo.
echo ================================================
echo  PrintGo Kiosk Setup - Step 4: Chrome Kiosk Mode
echo ================================================
echo.

echo [SECURITY WARNING] The legacy "--kiosk" switch is insecure and easily bypassed.
echo We no longer automatically create a shortcut for it.
echo.
echo Please configure Windows Assigned Access (Shell Launcher) instead:
echo   1. Go to Windows Settings ^> Accounts ^> Family and other users
echo   2. Set up a kiosk (Assigned access)
echo   3. Choose Microsoft Edge or Google Chrome
echo   4. Set the URL to your deployed frontend (e.g. https://your-printgo-frontend.vercel.app/kiosk)
echo.
echo ================================================
echo  PrintGo Kiosk Setup - Step 5: Windows Hardening
echo ================================================
echo.

REM Disable Ctrl+Alt+Del options (requires Admin)
REM This prevents users from accessing Task Manager
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableTaskMgr /t REG_DWORD /d 1 /f 2>nul

REM Disable right-click on desktop
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" /v NoViewContextMenu /t REG_DWORD /d 1 /f 2>nul

REM Hide taskbar
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3" /v Settings /t REG_BINARY /d 30000000feffffff0200000003000000 /f 2>nul

echo.
echo ================================================
echo  PrintGo Kiosk Setup - Step 6: OTA Updater
echo ================================================
echo.

REM Schedule the OTA Updater to run daily at 3:00 AM
REM This keeps the kiosk agent up to date automatically
schtasks /create /tn "PrintGo_OTA_Updater" /tr "\"%~dp0update_agent.bat\"" /sc daily /st 03:00 /ru SYSTEM /f
echo Scheduled OTA Update task for 3:00 AM daily.

echo.
echo ================================================
echo  SETUP COMPLETE!
echo ================================================
echo.
echo  The following has been configured:
echo    [x] PrintGo Agent running via PM2 (auto-restarts)
echo    [x] Chrome kiosk mode (fullscreen, no address bar)
echo    [x] Auto-start on Windows boot
echo    [x] Task Manager disabled
echo    [x] Right-click disabled
echo.
echo  IMPORTANT NEXT STEPS:
echo    1. Configure Windows Auto-Login:
echo       - Run: netplwiz
echo       - Uncheck "Users must enter a username and password"
echo       - Enter the kiosk user credentials
echo    2. For maximum security, use Windows 10/11 Assigned Access:
echo       - Settings ^> Accounts ^> Family and other users
echo       - Set up assigned access ^> Choose Chrome or Edge
echo       - Enter your frontend URL
echo    3. Test by rebooting the PC
echo  To UNDO all changes, run: setup_kiosk_undo.bat
echo.
pause
