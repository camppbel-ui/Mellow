<#
  lock-folder.ps1

  Demoting your daily account stops it killing the tasks. It does not stop it
  editing this folder, and this folder is where tasks.json lives. A standard
  user who can open tasks.json in Notepad and delete every task has defeated
  the whole thing without needing admin at all.

  This makes the folder readable by everyone and writable only by
  Administrators and SYSTEM.

  Run LAST, from an ADMINISTRATOR PowerShell, once you are happy with
  tasks.json and config.json:

      powershell -ExecutionPolicy Bypass -File .\install\lock-folder.ps1

  To undo it:
      powershell -ExecutionPolicy Bypass -File .\install\lock-folder.ps1 -Unlock

  What stays writable to your account is only what the notification agent,
  which runs as you, has to touch: its log and the notification queue.

  history.json is NOT writable, and that is deliberate. Clicking Done on the
  dashboard asks the engine to record it, and the engine runs as SYSTEM, so
  the dashboard keeps working. A history file you can edit in Notepad is a
  history file you can fill with completions that never happened.

  google-tokens.json goes further: not even readable by your account. It holds
  the sign-ins for your mail. Only SYSTEM and Administrators can open it.
#>

param([switch]$Unlock, [switch]$Force)

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

# The files that decide what happens. These are the ones worth protecting.
$guarded = @(
    'config.json',
    'ratchet-client.js',
    'engine\tasks.json',
    'engine\history.json',
    'engine\auto-tasks.json',
    'engine\engine-config.json',
    'engine\google.json',
    'engine\google-accounts.json',
    'engine\engine.js',
    'engine\dashboard.html',
    # Whether the assistant may change the blocking rules. Editable in Notepad
    # would make that switch a formality.
    'engine\ai.json'
)

if ($Unlock) {
    Write-Host "Restoring inherited permissions on $root" -ForegroundColor Cyan
    icacls "$root" /reset /T /C | Out-Null
    Write-Host "Done. Everything is editable again." -ForegroundColor Green
    exit 0
}

# This is the LAST step. Run it early and it locks out the very tools you still
# need, including anything editing these files on your behalf. Check that the
# things it is meant to protect actually exist first.
$notReady = @()
foreach ($t in @('Ratchet-Engine', 'Ratchet')) {
    if (-not (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue)) {
        $notReady += "the $t task is not registered"
    }
}
$cfgPath = Join-Path $root 'config.json'
if (Test-Path $cfgPath) {
    $cfg = ([System.IO.File]::ReadAllText($cfgPath)).TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($cfg.safety.dryRun) { $notReady += "safety.dryRun is still true, so nothing is being enforced yet" }
}

if ($notReady.Count -gt 0 -and -not $Force) {
    Write-Host "Not locking yet. This is the last step and you are not there." -ForegroundColor Yellow
    Write-Host ""
    foreach ($n in $notReady) { Write-Host "  - $n" }
    Write-Host ""
    Write-Host "Finish the setup first. Locking now makes these files read-only" -ForegroundColor Yellow
    Write-Host "to anything not running elevated, which includes the editors and" -ForegroundColor Yellow
    Write-Host "assistants you are still using to set this up." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Add -Force if you really mean it." -ForegroundColor Yellow
    exit 1
}

Write-Host "Locking down $root" -ForegroundColor Cyan
Write-Host ""

# Break inheritance, then rebuild the list explicitly. Copying the inherited
# entries first and stripping Users afterwards leaves the SIDs of accounts that
# no longer exist; starting from nothing does not.
icacls "$root" /inheritance:r /C | Out-Null

icacls "$root" /grant "*S-1-5-32-544:(OI)(CI)F"  /C | Out-Null   # Administrators - full
icacls "$root" /grant "*S-1-5-18:(OI)(CI)F"      /C | Out-Null   # SYSTEM - full
icacls "$root" /grant "*S-1-5-32-545:(OI)(CI)RX" /C | Out-Null   # Users - read and execute

# Hand back write access only where the notification agent, which runs as
# you, has to write. Everything else is written by the SYSTEM tasks, which
# already have full control and do not need a hole left open for them.
$writable = @(
    'ratchet-client.log'
)
foreach ($rel in $writable) {
    $p = Join-Path $root $rel
    if (-not (Test-Path $p)) { New-Item -ItemType File -Path $p | Out-Null }
    icacls "$p" /grant "*S-1-5-32-545:M" /C | Out-Null
}

# The notification queue: SYSTEM writes into it, the agent deletes from it.
$queue = Join-Path $root 'notify-queue'
if (-not (Test-Path $queue)) { New-Item -ItemType Directory -Path $queue -Force | Out-Null }
icacls "$queue" /grant "*S-1-5-32-545:(OI)(CI)M" /C | Out-Null

# Pictures for the sleep screen. They decide nothing, so adding one should not
# need the admin account.
$art = Join-Path $root 'engine\art'
if (-not (Test-Path $art)) { New-Item -ItemType Directory -Path $art -Force | Out-Null }
icacls "$art" /grant "*S-1-5-32-545:(OI)(CI)M" /C | Out-Null

# Google sign-ins: readable by SYSTEM and Administrators only. Inheritance is
# cut on this one file so the Users read entry on the folder does not reach it.
$tokens = Join-Path $root 'engine\google-tokens.json'
if (Test-Path $tokens) {
    icacls "$tokens" /inheritance:r /C | Out-Null
    icacls "$tokens" /grant "*S-1-5-32-544:F" /C | Out-Null
    icacls "$tokens" /grant "*S-1-5-18:F" /C | Out-Null
}

Write-Host ""
Write-Host "Read-only for standard users:" -ForegroundColor Green
foreach ($g in $guarded) { Write-Host "  $g" }
Write-Host ""
Write-Host "Still writable, because the notification agent runs as you:" -ForegroundColor Green
foreach ($w in $writable) { Write-Host "  $w" }
Write-Host "  notify-queue\"
Write-Host "  engine\art\  (your sleep screen pictures)"
if (Test-Path $tokens) {
    Write-Host ""
    Write-Host "Not readable at all by your account:" -ForegroundColor Green
    Write-Host "  engine\google-tokens.json"
}
Write-Host ""
Write-Host "Editing tasks.json now needs the admin account. That is the point." -ForegroundColor Yellow
Write-Host "Undo with:  .\install\lock-folder.ps1 -Unlock" -ForegroundColor Yellow
