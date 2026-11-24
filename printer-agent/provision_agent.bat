@echo off
setlocal EnableDelayedExpansion

REM ==============================================================
REM PrintGo Printer Agent - Dedicated Provisioning Script
REM ==============================================================
REM Run this script ONCE when commissioning a genuine fresh installation
REM or when an authorized operator must force-reprovision a machine.
REM
REM Normal Agent startup and PM2 NEVER provision or force-reprovision.
REM ==============================================================

cd /d "%~dp0"

echo.
echo ==============================================================
echo  PrintGo Printer Agent - Dedicated Provisioning Tool
echo ==============================================================
echo.

REM 1. Verify Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not found in PATH!
    echo Please install Node.js before running provisioning.
    echo.
    exit /b 1
)

REM 2. Verify dependencies are installed
if not exist "node_modules\" (
    echo [ERROR] Dependencies are missing!
    echo Please run 'npm install' first before provisioning.
    echo.
    exit /b 1
)

REM 3. Check for casual '--force' alias rejection
if "%~1"=="--force" (
    echo.
    echo [REJECTED] The casual '--force' flag is strictly prohibited.
    echo To authorize destructive reprovisioning, you must pass:
    echo     provision_agent.bat --force-reprovision
    echo.
    exit /b 1
)

REM 4. Handle Force-Reprovision
if "%~1"=="--force-reprovision" (
    echo.
    echo ==============================================================
    echo [DESTRUCTIVE WARNING] FORCE-REPROVISIONING REQUESTED!
    echo ==============================================================
    echo This will RESET the local job journal and generate a new installation ID.
    echo Any uncompleted or historical jobs in the local journal will be lost.
    echo.
    echo PRE-REQUISITE CHECKLIST:
    echo   [ ] 1. The physical printer output tray has been inspected and cleared.
    echo   [ ] 2. All outstanding jobs in the Admin Dashboard are reconciled or canceled.
    echo   [ ] 3. The running Agent has been stopped - run pm2 stop PrintGo_Agent
    echo ==============================================================
    echo.

    set "CONFIRMED="
    set /p CONFIRMED="Type 'YES' to confirm destructive force-reprovisioning: "

    if not "!CONFIRMED!"=="YES" goto :abort_force_reprovision

    echo.
    echo Proceeding with authorized force-reprovisioning...
    set "AGENT_REPROVISION_AUTH=AUTHORIZED_BY_OPERATOR"
    node src/provision.js --force-reprovision
    set "FORCE_RESULT=!ERRORLEVEL!"
    set "AGENT_REPROVISION_AUTH="

    if !FORCE_RESULT! neq 0 (
        echo.
        echo [ERROR] Force-reprovisioning failed!
        exit /b !FORCE_RESULT!
    )
    echo.
    echo ==============================================================
    echo [SUCCESS] Force-reprovisioning completed successfully.
    echo You may now start the agent normally: pm2 start PrintGo_Agent
    echo ==============================================================
    echo.
    exit /b 0
)

REM 5. Genuine Fresh Provisioning (Normal Path)
echo Checking installation environment...
node src/provision.js
if %ERRORLEVEL% neq 0 (
    echo.
    echo [PROVISIONING HALTED] Normal provisioning was refused.
    echo If this is an existing installation, customer data was preserved.
    exit /b %ERRORLEVEL%
)

echo.
echo ==============================================================
echo [SUCCESS] Agent provisioned successfully!
echo Next steps:
echo   1. Verify 'data\.installation_marker' and 'data\jobs.journal.json' exist.
echo   2. Start the Agent normally using PM2: pm2 start index.js --name "PrintGo_Agent"
echo   3. Verify backend registration and printer status.
echo ==============================================================
echo.
exit /b 0

:abort_force_reprovision
echo.
echo [ABORTED] Force-reprovisioning was cancelled by operator.
echo No changes were made to existing installation data.
echo.
exit /b 1
