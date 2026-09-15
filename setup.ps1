<#
  setup.ps1 - one-command setup for the PC (host machine).

  Run in an ADMINISTRATOR PowerShell window, from the ratchet folder:

      powershell -ExecutionPolicy Bypass -File .\setup.ps1

  It will:
    1. check for / install Node.js
    2. stop the PC sleeping (the single most common cause of "it stopped working")
    3. check for / install Tailscale
    4. ask for your engine URL and write it into config.json
    5. run the test suite
    6. run a dry-run cycle so you can see what WOULD be blocked
    7. offer to register the boot task

  It does NOT turn enforcement on. dryRun stays true until you set it yourself.
#>

$ErrorActionPreference = 'Stop'

function Say($msg, $color = 'White') { Write-Host $msg -ForegroundColor $color }
function Step($n, $msg) { Write-Host ""; Write-Host "[$n] $msg" -ForegroundColor Cyan }

# Set-Content -Encoding UTF8 writes a byte-order mark, and Node's JSON.parse
# refuses a file that starts with one. Writing it ourselves avoids handing the
# client a config it cannot read.
function Write-NoBom($path, $text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
}

# Replace only the server.url value. Rewriting the whole file through
# ConvertTo-Json would throw away every comment in it, and config.json is the
# one file that is meant to be read by a human.
function Set-EngineUrl($path, $url) {
    $text = [System.IO.File]::ReadAllText($path)
    $escaped = ($url -replace '\\', '\\\\')
    $re = New-Object System.Text.RegularExpressions.Regex '("url"\s*:\s*")[^"]*(")'
    if (-not $re.IsMatch($text)) { throw "Could not find server.url in $path" }
    # $1 and $2 keep the surrounding quotes; count 1 stops it touching anything else.
    $updated = $re.Replace($text, ('${1}' + $escaped + '${2}'), 1)
    Write-NoBom $path $updated
}

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
   ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Say "This needs Administrator. Right-click PowerShell -> Run as administrator, then re-run." Red
    exit 1
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
Say "Mellow setup - working in $root" Green

# --- 1. Node ----------------------------------------------------------------
Step 1 "Node.js"
$node = (Get-Command node -ErrorAction SilentlyContinue)
if ($node) {
    Say "  found: $(node --version)" Green
} else {
    Say "  not found. Installing via winget..." Yellow
    try {
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")
        Say "  installed. If 'node' is still not found, close and reopen PowerShell, then re-run this script." Yellow
    } catch {
        Say "  winget failed. Install Node LTS manually from nodejs.org, then re-run." Red
        exit 1
    }
}

# --- 2. Sleep ---------------------------------------------------------------
Step 2 "Power settings"
Say "  A PC that sleeps is a PC that is not hosting."
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Say "  Sleep and hibernate disabled while plugged in. (Display timeout left alone.)" Green

# --- 3. Tailscale -----------------------------------------------------------
Step 3 "Tailscale"
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue)
if ($ts) {
    Say "  already installed." Green
} else {
    $ans = Read-Host "  Install Tailscale now? Needed only if the Mac must reach this PC. (y/n)"
    if ($ans -eq 'y') {
        try {
            winget install -e --id tailscale.tailscale --accept-source-agreements --accept-package-agreements
            Say "  installed. Sign in from the Tailscale tray icon - that part needs your Google login and cannot be scripted." Yellow
        } catch {
            Say "  winget failed. Grab it from tailscale.com/download instead." Yellow
        }
    } else {
        Say "  skipped." Yellow
    }
}

# --- 4. Config --------------------------------------------------------------
Step 4 "Engine URL"
$cfgPath = Join-Path $root 'config.json'
if (-not (Test-Path $cfgPath)) { Say "  config.json missing!" Red; exit 1 }

$cfg = ([System.IO.File]::ReadAllText($cfgPath)).TrimStart([char]0xFEFF) | ConvertFrom-Json
Say "  current: $($cfg.server.url)"
$newUrl = Read-Host "  Engine URL (Enter to keep, or e.g. http://localhost:7777/api/enforcement)"
if ($newUrl) {
    Set-EngineUrl $cfgPath $newUrl
    Say "  saved." Green
}

# --- 5. Tests ---------------------------------------------------------------
Step 5 "Test suites"
Say "  Client (what gets blocked):"
node test-logic.js
if ($LASTEXITCODE -ne 0) { Say "  Client tests failed - stopping." Red; exit 1 }

Push-Location (Join-Path $root 'engine')
try {
    foreach ($suite in @('test-engine.js', 'test-extract.js', 'test-calendar.js', 'test-google-e2e.js')) {
        Say "  Engine: $suite"
        node $suite
        if ($LASTEXITCODE -ne 0) { Say "  $suite failed - stopping." Red; exit 1 }
    }
} finally { Pop-Location }

# --- 6. Dry run -------------------------------------------------------------
Step 6 "Dry run"
Say "  Starting a mock engine at shield_all and running one cycle."
$mock = Start-Process node -ArgumentList "mock-server.js","shield_all" -PassThru -WindowStyle Hidden -WorkingDirectory $root
Start-Sleep -Seconds 2

# Point at the mock for one cycle, then put the real URL back whatever happens.
$saved = (([System.IO.File]::ReadAllText($cfgPath)).TrimStart([char]0xFEFF) | ConvertFrom-Json).server.url
Set-EngineUrl $cfgPath "http://localhost:7777/api/enforcement"

try { node ratchet-client.js --once } finally {
    Stop-Process -Id $mock.Id -Force -ErrorAction SilentlyContinue
    Set-EngineUrl $cfgPath $saved
}

Say ""
Say "  Read the DRY lines above. Those are the apps and sites it would block." Yellow
Say "  If anything looks wrong, fix the groups in config.json before going further." Yellow

# --- 7. Boot tasks ----------------------------------------------------------
Step 7 "Run at boot"
Say "  Three pieces: the engine decides, the client obeys, the agent tells you."
$ans = Read-Host "  Register the engine and client boot tasks now? (y/n)"
if ($ans -eq 'y') {
    & (Join-Path $root 'install\install-engine-task.ps1')
    & (Join-Path $root 'install\install-task.ps1')
    Start-ScheduledTask -TaskName Ratchet-Engine
    Start-ScheduledTask -TaskName Mellow
    Say "  Both started." Green
} else {
    Say "  skipped. Run install\install-engine-task.ps1 and install\install-task.ps1 later." Yellow
}

# --- 8. Notification agent --------------------------------------------------
Step 8 "Notifications"
Say "  The tasks above run as SYSTEM, which cannot draw anything on your screen."
Say "  The notification agent is the piece that can, and it has to be registered"
Say "  by the account you actually use - not from this elevated window."
Say ""
Say "  Open a NORMAL PowerShell window (not as administrator) and run:" Yellow
Say "      cd '$root'"
Say "      powershell -ExecutionPolicy Bypass -File .\install\install-notify-task.ps1"
Say ""
Say "  Then check it with:  node ratchet-client.js --test-notify" Yellow

# --- 9. Accounts ------------------------------------------------------------
Step 9 "The part that makes it stick"
Say "  Everything above is four seconds of Task Scheduler away from being turned"
Say "  off, for as long as your daily account has admin rights."
Say ""
Say "      powershell -ExecutionPolicy Bypass -File .\install\harden-account.ps1" Yellow
Say ""
Say "  It walks you through a separate admin account and demoting your daily one."

Write-Host ""
Say "Done. Enforcement is still OFF (safety.dryRun = true)." Green
Say "Dashboard: http://localhost:7777/" Green
Say "When the dry-run output looks right, set dryRun to false in config.json and restart the task." Yellow
