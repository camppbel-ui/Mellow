<#
  install-task.ps1

  Registers the Ratchet client as a Scheduled Task that starts at boot,
  runs as SYSTEM, and restarts itself if it dies.

  Run this from an ADMINISTRATOR PowerShell window:

      cd <this folder>
      powershell -ExecutionPolicy Bypass -File .\install-task.ps1

  To remove it later:
      Unregister-ScheduledTask -TaskName "Ratchet" -Confirm:$false
#>

$ErrorActionPreference = 'Stop'

# --- must be admin -----------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
   ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Error "Run this in an Administrator PowerShell window. Right-click PowerShell, 'Run as administrator'."
    exit 1
}

# --- locate node and the client ---------------------------------------------
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path

. (Join-Path $here 'find-node.ps1')
$node = Find-NodeExe
if (-not $node) {
    Write-Error "Node.js not found. Install it from nodejs.org, then reopen PowerShell."
    exit 1
}

$root   = Split-Path -Parent $here
$client = Join-Path $root 'ratchet-client.js'

if (-not (Test-Path $client)) {
    Write-Error "Cannot find ratchet-client.js at $client"
    exit 1
}

Write-Host "node   : $node"
Write-Host "client : $client"
Write-Host ""

# --- build the task ----------------------------------------------------------
$action = New-ScheduledTaskAction -Execute $node `
                                  -Argument "`"$client`"" `
                                  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtStartup

# SYSTEM so a standard (non-admin) user session cannot stop it from Task Manager.
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

Register-ScheduledTask -TaskName "Ratchet" `
                       -Action $action `
                       -Trigger $trigger `
                       -Principal $principal `
                       -Settings $settings `
                       -Description "Ratchet enforcement client - polls the engine and applies shields." `
                       -Force | Out-Null

Write-Host "Registered scheduled task 'Ratchet'." -ForegroundColor Green
Write-Host ""
Write-Host "Start it now with:   Start-ScheduledTask -TaskName Ratchet"
Write-Host "Check it with:       Get-ScheduledTask -TaskName Ratchet"
Write-Host "Watch the log:       Get-Content '$root\ratchet-client.log' -Wait -Tail 20"
Write-Host ""
Write-Host "Leave safety.dryRun = true in config.json until that log looks right." -ForegroundColor Yellow
