<#
  install-notify-task.ps1

  The enforcement task runs as SYSTEM, in session 0. Nothing SYSTEM draws to
  the screen is ever visible to you, so it queues notifications to disk instead.
  This registers the other half: a small agent that runs in YOUR logged-in
  session, picks the queue up, and shows the toasts.

  Run this as your normal user - NOT as Administrator. A task registered by the
  admin account runs in the admin account's session, which is the one you are
  trying not to live in.

      powershell -ExecutionPolicy Bypass -File .\install\install-notify-task.ps1

  To remove it later:
      Unregister-ScheduledTask -TaskName "Ratchet-Notify" -Confirm:$false
#>

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
   ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdmin) {
    Write-Host "This window is elevated." -ForegroundColor Yellow
    Write-Host "The agent must run as the account you actually use, or you will not see the toasts." -ForegroundColor Yellow
    $ans = Read-Host "Register it for '$env:USERNAME' anyway? (y/n)"
    if ($ans -ne 'y') { exit 1 }
}

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

# --- register the AUMID so toasts say "Mellow" ------------------------------
# A toast whose app id Windows does not recognise is accepted and then silently
# never drawn. This is a per-user registry key, so no elevation is needed.
$aumidKey = 'HKCU:\SOFTWARE\Classes\AppUserModelId\Ratchet.Enforcement'
if (-not (Test-Path $aumidKey)) { New-Item -Path $aumidKey -Force | Out-Null }
New-ItemProperty -Path $aumidKey -Name 'DisplayName' -Value 'Mellow' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $aumidKey -Name 'ShowInSettings' -Value 1 -PropertyType DWord -Force | Out-Null
Write-Host "Registered toast app id 'Ratchet.Enforcement' for $env:USERNAME."

# --- register the agent -------------------------------------------------------
# node.exe is a console program, so run directly in your session it opens a
# black window - which looks like junk, gets closed, and takes notifications
# with it. conhost --headless gives it a console with no window at all.
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$action = New-ScheduledTaskAction -Execute $conhost `
                                  -Argument "--headless `"$node`" `"$client`" --notify-agent" `
                                  -WorkingDirectory $root

# At logon, and then every five minutes. The repeat is the safety net: if the
# agent ever stops, the next tick starts it again, and while it is running the
# tick does nothing because a second copy is refused below.
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$trigger = @($atLogon, $every5)

# Interactive, so it lands in the desktop session. Limited, because drawing a
# toast needs no privilege at all.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
                                        -LogonType Interactive `
                                        -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

# Stop a running copy first, so re-registering swaps in the new launch method
# instead of leaving the old windowed one alive.
Stop-ScheduledTask -TaskName "Ratchet-Notify" -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName "Ratchet-Notify" `
                       -Action $action `
                       -Trigger $trigger `
                       -Principal $principal `
                       -Settings $settings `
                       -Description "Ratchet notification agent - draws toasts that the SYSTEM enforcement task cannot." `
                       -Force | Out-Null

Write-Host "Registered scheduled task 'Ratchet-Notify'." -ForegroundColor Green
Write-Host ""
Write-Host "Start it now with:   Start-ScheduledTask -TaskName Ratchet-Notify"
Write-Host "Test a toast with:   node `"$client`" --test-notify"
