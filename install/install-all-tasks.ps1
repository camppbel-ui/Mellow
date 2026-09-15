<#
  install-all-tasks.ps1

  Registers both SYSTEM tasks and starts them. The engine first, because the
  client has nothing to ask until it is up.

  Run from an ADMINISTRATOR PowerShell:

      powershell -ExecutionPolicy Bypass -File .\install\install-all-tasks.ps1

  The notification agent is deliberately NOT here. It has to be registered by
  the account you actually use, from a normal window, or you never see a toast.
  See install-notify-task.ps1.
#>

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
   ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "Run this in an Administrator PowerShell window." -ForegroundColor Red
    exit 1
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here

Write-Host "=== Engine ===" -ForegroundColor Cyan
& (Join-Path $here 'install-engine-task.ps1')

Write-Host ""
Write-Host "=== Client ===" -ForegroundColor Cyan
& (Join-Path $here 'install-task.ps1')

Write-Host ""
Write-Host "=== Starting ===" -ForegroundColor Cyan

# If the engine is already running by hand, the task's copy cannot bind the
# port. Clear the way rather than leaving a task that restarts and fails 999
# times in a row.
$stray = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
         Where-Object { $_.CommandLine -like '*engine.js*' }
foreach ($p in $stray) {
    Write-Host "  stopping a hand-started engine (pid $($p.ProcessId))" -ForegroundColor Yellow
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($stray) { Start-Sleep -Seconds 2 }

Start-ScheduledTask -TaskName Ratchet-Engine
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName Ratchet

Start-Sleep -Seconds 2
Get-ScheduledTask -TaskName Ratchet-Engine, Ratchet |
    Select-Object TaskName, State | Format-Table -AutoSize

Write-Host "Checking the engine answers..." -ForegroundColor Cyan
try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://localhost:7777/api/enforcement"
    Write-Host "  OK - level is $(($r.Content | ConvertFrom-Json).level)" -ForegroundColor Green
    Write-Host "  Dashboard: http://localhost:7777/" -ForegroundColor Green
} catch {
    Write-Host "  No answer yet. Check engine\engine.log." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Enforcement is still OFF while safety.dryRun is true in config.json." -ForegroundColor Yellow
