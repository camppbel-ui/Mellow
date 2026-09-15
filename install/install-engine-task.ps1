<#
  install-engine-task.ps1

  Registers the Ratchet ENGINE as a Scheduled Task that starts at boot and runs
  as SYSTEM. This is the half that decides; install-task.ps1 registers the half
  that obeys. You want both, and you want the engine to come up first.

  Run this from an ADMINISTRATOR PowerShell window:

      powershell -ExecutionPolicy Bypass -File .\install\install-engine-task.ps1

  To remove it later:
      Unregister-ScheduledTask -TaskName "Ratchet-Engine" -Confirm:$false
#>

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
   ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Error "Run this in an Administrator PowerShell window. Right-click PowerShell, 'Run as administrator'."
    exit 1
}

$here       = Split-Path -Parent $MyInvocation.MyCommand.Path

. (Join-Path $here 'find-node.ps1')
$node = Find-NodeExe
if (-not $node) {
    Write-Error "Node.js not found. Install it from nodejs.org, then reopen PowerShell."
    exit 1
}

$root       = Split-Path -Parent $here
$engineDir  = Join-Path $root 'engine'
$engine     = Join-Path $engineDir 'engine.js'

if (-not (Test-Path $engine)) {
    Write-Error "Cannot find engine.js at $engine"
    exit 1
}

Write-Host "node   : $node"
Write-Host "engine : $engine"
Write-Host ""

$action = New-ScheduledTaskAction -Execute $node `
                                  -Argument "`"$engine`"" `
                                  -WorkingDirectory $engineDir

$trigger = New-ScheduledTaskTrigger -AtStartup

# SYSTEM, so your standard-user session cannot stop the thing that decides
# whether you are allowed to play games.
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" `
                                        -LogonType ServiceAccount `
                                        -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask -TaskName "Ratchet-Engine" `
                       -Action $action `
                       -Trigger $trigger `
                       -Principal $principal `
                       -Settings $settings `
                       -Description "Ratchet engine - decides the enforcement level and serves the dashboard." `
                       -Force | Out-Null

Write-Host "Registered scheduled task 'Ratchet-Engine'." -ForegroundColor Green
Write-Host ""
Write-Host "Start it now with:   Start-ScheduledTask -TaskName Ratchet-Engine"
Write-Host "Dashboard:           http://localhost:7777/"
Write-Host "Watch the log:       Get-Content '$engineDir\engine.log' -Wait -Tail 20"
