<#
  finish-setup.ps1

  Every remaining step that only needs Administrator, in one run, so there is
  one consent prompt instead of five.

      powershell -ExecutionPolicy Bypass -File .\install\finish-setup.ps1

  It restarts the two SYSTEM tasks so they pick up any code changes, checks all
  three are actually running, and writes what it found to
  install\finish-setup.log so the result can be read back afterwards.

  What is deliberately NOT here, and why:

    - Signing in to Tailscale. That is an authentication flow against your own
      Google account. Nothing should drive that except you.
    - Demoting your daily account. That has to be run from the OTHER admin
      account, so that you find out the new password works while you still have
      a way back in.
    - Locking the folder. That is the last step, after dryRun is off, and it
      has its own guard.
#>

$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$log  = Join-Path $here 'finish-setup.log'

$lines = @()
function Report($msg, $color = 'White') {
    Write-Host $msg -ForegroundColor $color
    $script:lines += $msg
}

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
   ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    "NOT ELEVATED - nothing was done." | Set-Content -LiteralPath $log -Encoding utf8
    Write-Host "This needs Administrator." -ForegroundColor Red
    exit 1
}

Report "Ratchet finish-setup - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Report ""

# --- inbound rule for the tailnet --------------------------------------------
# Windows blocks inbound connections to a service that never got a prompt, so
# without this the phone gets a silent timeout while the engine sits there
# listening quite happily. Scoped to 100.64.0.0/10, the range Tailscale hands
# out, so this opens nothing on the dorm wifi or any other network.
Report "Firewall" 'Cyan'
$ruleName = 'Ratchet-dashboard-tailnet'
$port = 7777
$engineCfg = Join-Path $root 'engine\engine-config.json'
$bindHost = '127.0.0.1'
if (Test-Path $engineCfg) {
    $ecfg = ([System.IO.File]::ReadAllText($engineCfg)).TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($ecfg.port) { $port = $ecfg.port }
    if ($ecfg.bindHost) { $bindHost = $ecfg.bindHost }
}

Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

if ($bindHost -eq '127.0.0.1' -or $bindHost -eq '::1' -or $bindHost -eq 'localhost') {
    Report "  bindHost is loopback, so no inbound rule is needed." 'Green'
} else {
    try {
        New-NetFirewallRule -DisplayName $ruleName `
                            -Direction Inbound -Action Allow -Protocol TCP `
                            -LocalPort $port -RemoteAddress '100.64.0.0/10' `
                            -Profile Any `
                            -Description 'Ratchet dashboard, reachable from your Tailscale devices only.' `
                            | Out-Null
        Report "  allowed TCP $port inbound from 100.64.0.0/10 (Tailscale only)" 'Green'
    } catch {
        Report "  could not add the rule - $($_.Exception.Message)" 'Red'
    }
}
Report ""

# --- restart the SYSTEM tasks so they run the current code -------------------
Report "Restarting SYSTEM tasks" 'Cyan'
foreach ($t in @('Ratchet-Engine', 'Ratchet')) {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if (-not $task) { Report "  $t : NOT REGISTERED" 'Red'; continue }
    try {
        Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Start-ScheduledTask -TaskName $t
        Report "  $t : restarted"
    } catch {
        Report "  $t : restart failed - $($_.Exception.Message)" 'Red'
    }
}

# The engine has to be up before the client has anything to ask.
Start-Sleep -Seconds 4

# --- verify ------------------------------------------------------------------
Report ""
Report "Task state" 'Cyan'
foreach ($t in @('Ratchet-Engine', 'Ratchet', 'Ratchet-Notify')) {
    $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $t -ErrorAction SilentlyContinue
        Report ("  {0,-16} {1,-9} last result {2}" -f $t, $task.State, $info.LastTaskResult)
    } else {
        Report ("  {0,-16} NOT REGISTERED" -f $t) 'Red'
    }
}

Report ""
Report "Engine" 'Cyan'
Report "  bindHost: $bindHost   port: $port   token set: $([bool]$ecfg.token)"
try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 6 "http://127.0.0.1:$port/api/enforcement"
    Report "  responding, level = $(($r.Content | ConvertFrom-Json).level)" 'Green'
} catch {
    Report "  NOT RESPONDING - check engine\engine.log" 'Red'
}
# The icon route only exists in the newer code, so it doubles as a check that
# the restart actually picked up the current file rather than a cached one.
try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 6 "http://127.0.0.1:$port/icon-180.png"
    Report "  serving phone icons ($($r.RawContentLength) bytes) - running current code" 'Green'
} catch {
    Report "  icon route missing - the task is still running older code" 'Yellow'
}

# --- what is left, and who has to do it --------------------------------------
Report ""
Report "Still outstanding" 'Cyan'

$tsExe = "$env:ProgramFiles\Tailscale\tailscale.exe"
if (Test-Path $tsExe) {
    $status = (& $tsExe status 2>&1 | Out-String).Trim()
    if ($status -match 'Logged out|Log in at') {
        Report "  Tailscale: installed, LOGGED OUT. Only you can sign in." 'Yellow'
    } else {
        $ip = (& $tsExe ip -4 2>&1 | Out-String).Trim()
        Report "  Tailscale: signed in. This PC is $ip" 'Green'
        if ($bindHost -ne $ip -and $bindHost -notmatch '^(127\.0\.0\.1|::1|localhost)$') {
            Report "  MISMATCH: engine-config bindHost is $bindHost but Tailscale says $ip" 'Red'
        }
        Report "  Phone address: http://${ip}:$port/"
    }
} else {
    Report "  Tailscale: not installed" 'Yellow'
}

if (Get-LocalUser -Name RatchetAdmin -ErrorAction SilentlyContinue) {
    Report "  RatchetAdmin: exists" 'Green'
} else {
    Report "  RatchetAdmin: missing - run harden-account.ps1 -CreateAdmin" 'Yellow'
}

$clientCfg = Join-Path $root 'config.json'
if (Test-Path $clientCfg) {
    $c = ([System.IO.File]::ReadAllText($clientCfg)).TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($c.safety.dryRun) {
        Report "  Enforcement: OFF (safety.dryRun is true). Nothing is being blocked." 'Yellow'
    } else {
        Report "  Enforcement: ARMED" 'Green'
    }
}

$admins = @()
foreach ($m in (Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue)) {
    if ($m.ObjectClass -ne 'User') { continue }
    $n = ($m.Name -split '\\')[-1]
    $u = Get-LocalUser -Name $n -ErrorAction SilentlyContinue
    if ($u -and $u.Enabled) { $admins += $u.Name }
}
Report "  Enabled administrators: $($admins -join ', ')"

Report ""
$lines | Set-Content -LiteralPath $log -Encoding utf8
Write-Host "Written to $log" -ForegroundColor Green
