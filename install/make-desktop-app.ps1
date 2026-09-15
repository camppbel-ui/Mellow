<#
  make-desktop-app.ps1

  Puts Mellow on your desktop and in the Start menu.

      powershell -ExecutionPolicy Bypass -File .\install\make-desktop-app.ps1

  No admin needed. Run it as the account you actually use, because it writes to
  that account's desktop.

  It is not a packaged application, and it does not need to be. The dashboard is
  already a web page served by the engine, so the shortcut opens it in app mode:
  its own window, no address bar, no tabs, its own taskbar button and icon.
  Wrapping the same page in Electron would add 150MB to a project whose whole
  premise is that it depends on nothing.

  To remove it, delete the two shortcuts. Nothing else is touched.

      -Remove   deletes them for you
#>

param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$icon = Join-Path $root 'ratchet.ico'

$desktop   = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'

$targets = @(
    (Join-Path $desktop   'Ratchet.lnk'),
    (Join-Path $startMenu 'Ratchet.lnk'),
    # Opens edge to edge: no title bar, no taskbar. F11 or the Full screen
    # button in Mellow's sidebar leaves it.
    (Join-Path $startMenu 'Mellow (Full screen).lnk')
)

if ($Remove) {
    foreach ($t in $targets) {
        if (Test-Path $t) { Remove-Item $t -Force; Write-Host "removed $t" }
    }
    Write-Host "Done." -ForegroundColor Green
    exit 0
}

if (-not (Test-Path $icon)) {
    Write-Host "No ratchet.ico yet. Building it." -ForegroundColor Yellow
    & (Join-Path $here 'make-icon.ps1')
}

# --- read the port out of the engine's own config, so the two cannot drift ----
$port = 7777
$engineCfg = Join-Path $root 'engine\engine-config.json'
if (Test-Path $engineCfg) {
    $cfg = ([System.IO.File]::ReadAllText($engineCfg)).TrimStart([char]0xFEFF) | ConvertFrom-Json
    if ($cfg.port) { $port = $cfg.port }
}
$url = "http://localhost:$port/"

# --- find a Chromium browser for app mode ------------------------------------
# App mode is the whole point: no tabs, no address bar, its own taskbar button.
# Chrome first: links clicked in the app window open in whichever browser hosts
# it, so an Edge window sends every link to Edge. Edge is only the fallback.
$browser = $null
$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { $browser = $c; break }
}

$shell = New-Object -ComObject WScript.Shell

foreach ($target in $targets) {
    $dir = Split-Path -Parent $target
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    $sc = $shell.CreateShortcut($target)
    if ($browser) {
        $sc.TargetPath = $browser
        # --app= gives a plain window. The separate profile directory stops the
        # window inheriting whatever tabs and sessions your normal browser has
        # open, so it behaves like an application rather than a browser.
        $sc.Arguments = "--app=$url"
        if ($target -like '*Full screen*') { $sc.Arguments = "--app=$url --start-fullscreen" }
    } else {
        # No Chromium browser. Fall back to the default handler, which at least
        # opens the right page.
        $sc.TargetPath = $url
    }
    $sc.IconLocation = "$icon,0"
    $sc.Description = 'Mellow - what is overdue and what it costs you'
    $sc.WorkingDirectory = $root
    $sc.Save()

    Write-Host "created $target"
}

Write-Host ""
if ($browser) {
    Write-Host "App mode via $(Split-Path -Leaf $browser)." -ForegroundColor Green
} else {
    Write-Host "No Edge or Chrome found, so it opens in your default browser instead." -ForegroundColor Yellow
}
Write-Host "Opens $url" -ForegroundColor Green
Write-Host ""
Write-Host "The engine has to be running for it to show anything. It starts at boot" -ForegroundColor Yellow
Write-Host "via the Ratchet-Engine task, so normally it already is." -ForegroundColor Yellow
