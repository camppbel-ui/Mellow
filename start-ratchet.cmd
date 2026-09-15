@echo off
rem Starts Mellow in this window and opens the dashboard. Close the window to stop it.
rem No admin needed. For starting with Windows, see START-HERE.md.

cd /d "%~dp0"

rem An update brought a newer copy of this file: swap it in and start again from it.
if exist "start-ratchet.cmd.new" (
  move /y "start-ratchet.cmd.new" "start-ratchet.cmd" >nul
  start "Mellow" "%~dp0start-ratchet.cmd"
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Mellow needs Node.js, and it is not installed.
  echo Get the LTS version from https://nodejs.org, install it, then run this again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

rem Already running? Just open it.
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7777/api/enforcement -TimeoutSec 2) | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  start "" http://localhost:7777/
  exit /b 0
)

echo Starting Mellow. Leave this window open; close it to stop.
start "" /b cmd /c "timeout /t 2 >nul & start "" http://localhost:7777/"
set MELLOW_LAUNCHER=1
:run
node engine\engine.js
rem 75 means an update was installed: start the new version.
if %errorlevel%==75 (
  echo.
  echo Mellow was updated. Starting the new version...
  goto run
)
pause
