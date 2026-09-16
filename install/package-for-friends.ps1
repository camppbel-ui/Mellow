<#
  package-for-friends.ps1

  Builds a copy of Mellow you can send to a friend: the app, with none of you
  in it. No admin needed.

      powershell -ExecutionPolicy Bypass -File .\install\package-for-friends.ps1

  It writes dist\Ratchet-<date>.zip. What goes in is a list of the app's own
  files, never "everything except"; your data can only end up in the zip if
  someone adds it to that list on purpose.

  Left out, always:
    Google sign-ins, your OAuth client, connected accounts, synced mail and
    calendars, history, tasks you captured, finances, dropped files,
    assistant conversations, your AI key and spend, caches and logs.

  Reset to a clean start:
    engine-config.json (no name, no token, localhost only), tasks.json (two
    example chores), stocks.json (example tickers), news.json (no
    subscriptions), config.json (enforcement back to dry run), ai.json.

  Then every text file in the package is searched for anything of yours it
  can find - your email addresses, your name, your engine token, your
  Tailscale address, your OAuth client id, API keys, refresh tokens - and the
  zip is not written if one turns up.

  Mellow is shared under the PolyForm Noncommercial License: friends can use
  and change it, nobody can sell it.

      -OutDir <path>   where the zip goes (default: dist\ in the Mellow folder)
      -Version <v>     the version to stamp, like 2026.09.20 (default: today's date).
                       Written into engine\version.json here and in the package, so
                       your copy and the release agree and yours never offers to update.
                       Releasing twice in one day? Use 2026.09.20.2.

  Besides Mellow-<date>.zip it writes Mellow.zip, the name every release uses:
  the website's download link and each copy's updater both look for it.
#>

param([string]$OutDir, [string]$Version)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$engine = Join-Path $root 'engine'
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }

function Read-JsonFile($path) {
    if (-not (Test-Path $path)) { return $null }
    try { return ([System.IO.File]::ReadAllText($path)).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { return $null }
}

function Write-NoBom($path, $text) {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
}

# --- what is yours, so it can be searched for --------------------------------

$markers = New-Object System.Collections.Generic.List[string]
$accounts = Read-JsonFile (Join-Path $engine 'google-accounts.json')
if ($accounts -and $accounts.accounts) {
    foreach ($p in $accounts.accounts.PSObject.Properties) { $markers.Add($p.Name) }
}
$cfg = Read-JsonFile (Join-Path $engine 'engine-config.json')
if ($cfg) {
    if ($cfg.name -and $cfg.name.Length -ge 3) { $markers.Add([string]$cfg.name) }
    if ($cfg.token) { $markers.Add([string]$cfg.token) }
    foreach ($h in @($cfg.bindHost)) { if ($h -and $h -notmatch '^(127\.0\.0\.1|::1|localhost)$') { $markers.Add([string]$h) } }
}
Get-ChildItem $engine -Filter 'client_secret_*.json' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -match 'client_secret_(\d+)-') { $markers.Add($Matches[1]) }
}
$keyFile = Join-Path $engine 'ai-key.txt'
if (Test-Path $keyFile) { $k = ([System.IO.File]::ReadAllText($keyFile)).Trim(); if ($k) { $markers.Add($k) } }

# Stand-ins for the few places the docs and tests name you.
$standIns = @{}
$i = 0
foreach ($m in $markers) {
    if ($m -match '@') { $standIns[$m] = if ($i -eq 0) { 'you@gmail.com' } else { "you$i@school.edu" }; $i++ }
}
if ($cfg -and $cfg.name) { $standIns[[string]$cfg.name] = 'Alex' }

# --- the app's own files -----------------------------------------------------

$stamp = Get-Date -Format 'yyyy-MM-dd'

# --- the version -------------------------------------------------------------
if (-not $Version) { $Version = Get-Date -Format 'yyyy.MM.dd' }
if ($Version -notmatch '^\d{4}\.\d{2}\.\d{2}(\.\d+)?$') { Write-Host "Version should look like 2026.09.20 or 2026.09.20.2" -ForegroundColor Red; exit 1 }
$versionFile = Join-Path $engine 'version.json'
$verInfo = Read-JsonFile $versionFile
if (-not $verInfo) { $verInfo = [pscustomobject]@{ version = ''; repo = 'camppbel-ui/Mellow'; site = 'https://mellow-track.com' } }
$verJson = @"
{
  "_comment": "Which Mellow this is, and where new versions are published. Stamped by install/package-for-friends.ps1; don't edit by hand.",
  "version": "$Version",
  "repo": "$($verInfo.repo)",
  "site": "$($verInfo.site)"
}
"@
Write-NoBom $versionFile $verJson
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "ratchet-package-$stamp-$([guid]::NewGuid().ToString('N').Substring(0, 6))"
$app = Join-Path $stage 'Mellow'
New-Item -ItemType Directory -Path $app -Force | Out-Null

$include = @(
    'README.md', 'SETUP.md', 'GOOGLE-SETUP.md', 'setup.ps1', 'setup.sh', 'start-ratchet.cmd', 'start-ratchet.command',
    'ratchet-client.js', 'mock-server.js', 'test-logic.js', 'ratchet.ico',
    'lib\blockset.js', 'lib\enforce.js', 'lib\notify.js', 'lib\util.js', 'lib\platform\windows.js', 'lib\platform\macos.js',
    'engine\engine.js', 'engine\dashboard.html', 'engine\favicon.png', 'engine\icon-180.png', 'engine\icon-192.png', 'engine\icon-512.png',
    'engine\google.json', 'engine\calendars.json', 'engine\art\README.txt', 'engine\version.json',
    # A shared Google sign-in client, if you've made one for friends (GOOGLE-SETUP.md, "Letting friends skip this").
    # Only this name ships: your own client_secret_*.json never does.
    'engine\google-shared-client.json'
)
$includeDirs = @(
    @{ dir = 'engine\lib'; filter = '*.js' },
    @{ dir = 'install'; filter = '*.ps1' },
    @{ dir = 'install'; filter = '*.sh' },
    @{ dir = 'engine'; filter = 'test-*.js'; flat = $true }
)

$copied = 0
foreach ($rel in $include) {
    $src = Join-Path $root $rel
    if (-not (Test-Path $src)) { continue }
    $dst = Join-Path $app $rel
    New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
    Copy-Item $src $dst
    $copied++
}
foreach ($d in $includeDirs) {
    $base = Join-Path $root $d.dir
    if (-not (Test-Path $base)) { continue }
    $files = if ($d.flat) { Get-ChildItem $base -File -Filter $d.filter } else { Get-ChildItem $base -File -Recurse -Filter $d.filter }
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($root.Length).TrimStart('\')
        if ($rel -like 'install\app\*') { continue }   # the Windows and Mac apps' launchers: build-apps.ps1 builds those
        $dst = Join-Path $app $rel
        New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
        Copy-Item $f.FullName $dst
        $copied++
    }
}

# --- a clean start in place of your settings --------------------------------

Write-NoBom (Join-Path $app 'engine\engine-config.json') @'
{
  "_comment": "Engine settings. Tasks live in tasks.json; this is just how the server behaves.",

  "name": "",
  "_name_note": "What the dashboard calls you in its greeting.",

  "port": 7777,

  "bindHost": "127.0.0.1",
  "_bindHost_note": "127.0.0.1 keeps the dashboard on this computer. To open it on your phone over Tailscale, put your Tailscale address here AND set a token below.",

  "token": "",

  "passesPerWeek": 2,
  "_passes_note": "A pass clears a task without doing it. Rolling 7-day window, not a calendar week.",

  "recheckInSeconds": 60
}
'@

Write-NoBom (Join-Path $app 'engine\tasks.json') @'
{
  "_comment": "The recurring things you do by hand. Homework and email are NOT here - those come from your Google accounts automatically. Edit this file, then restart the engine.",

  "_cadence_help": {
    "daily": { "type": "daily", "dueBy": "21:00" },
    "weekdays": { "type": "weekdays", "dueBy": "17:00" },
    "specific days": { "type": "days", "days": ["sun"], "dueBy": "20:00" },
    "every N days since you last did it": { "type": "everyNDays", "n": 3, "dueBy": "21:00" }
  },

  "tasks": [
    {
      "id": "laundry",
      "title": "Laundry",
      "group": "weekly",
      "clearedBy": "Wash, dry and put it away, then mark it here",
      "cadence": { "type": "days", "days": ["sun"], "dueBy": "20:00" },
      "escalation": [
        { "afterMinutes": -240, "level": "nudge" },
        { "afterMinutes": 0, "level": "persistent" }
      ]
    },
    {
      "id": "finances",
      "title": "Check on your finances",
      "group": "weekly",
      "clearedBy": "Look over your accounts, card balance and anything coming due, then mark it here",
      "cadence": { "type": "days", "days": ["sun"], "dueBy": "20:00" },
      "escalation": [
        { "afterMinutes": -240, "level": "nudge" },
        { "afterMinutes": 0, "level": "persistent" }
      ]
    }
  ]
}
'@

Write-NoBom (Join-Path $app 'engine\stocks.json') @'
{
  "_comment": "The stocks shown on the News page, the sleep screen and the morning briefing. Prices come from Yahoo Finance and can be up to 15 minutes delayed.",
  "symbols": ["SPY", "AAPL", "MSFT", "NVDA"],
  "_symbols_note": "Ticker symbols, in the order you want them shown. Add or remove freely.",
  "names": { "SPY": "S&P 500 ETF", "AAPL": "Apple", "MSFT": "Microsoft", "NVDA": "Nvidia" },
  "colors": {},
  "domains": {},
  "_domains_note": "Well-known companies show their logo on their own. For any other, add its website here, like \"AEVA\": \"aeva.com\".",
  "refreshMinutes": 5
}
'@

$news = Read-JsonFile (Join-Path $engine 'news.json')
if ($news) {
    if ($news.PSObject.Properties['subscriptions']) { $news.subscriptions = @() }
    Write-NoBom (Join-Path $app 'engine\news.json') ($news | ConvertTo-Json -Depth 10)
}

Write-NoBom (Join-Path $app 'engine\ai.json') @'
{
  "_comment": "Mellow AI settings. The API key is not kept here: add it on the Accounts page, or put it in engine/ai-key.txt.",
  "enabled": true,
  "model": "claude-opus-5",
  "assistantEffort": "high",
  "scanEffort": "medium",
  "monthlyLimitUsd": 10,
  "assistantCanEditEnforcement": false,
  "_assistantCanEditEnforcement_note": "false: the assistant can read but not change the files that decide what gets blocked, or its own guards. Only change this by hand."
}
'@

# Enforcement goes back to dry run: a friend should see what it would block before it blocks anything.
$clientCfg = Join-Path $root 'config.json'
if (Test-Path $clientCfg) {
    $text = [System.IO.File]::ReadAllText($clientCfg).TrimStart([char]0xFEFF)
    $text = [regex]::Replace($text, '("dryRun"\s*:\s*)(true|false)', '${1}true')
    $text = [regex]::Replace($text, '("url"\s*:\s*")[^"]*(")', '${1}http://localhost:7777/api/enforcement${2}', 1)
    Write-NoBom (Join-Path $app 'config.json') $text
}

New-Item -ItemType Directory -Path (Join-Path $app 'engine\art') -Force | Out-Null

# --- stand-ins in docs and tests ---------------------------------------------

$textExt = @('.md', '.js', '.json', '.ps1', '.sh', '.cmd', '.html', '.txt')
# Only documentation and tests: a stand-in swapped into code could change what it does.
$docsAndTests = Get-ChildItem $app -File -Recurse | Where-Object { $_.Extension -eq '.md' -or $_.Name -like 'test-*.js' }
foreach ($f in $docsAndTests) {
    $t = [System.IO.File]::ReadAllText($f.FullName)
    $orig = $t
    foreach ($k in $standIns.Keys) { $t = $t.Replace($k, $standIns[$k]) }
    if ($t -ne $orig) { Write-NoBom $f.FullName $t }
}

# --- the licence and the first page a friend reads ---------------------------

$srcFriends = Join-Path $root 'FRIENDS.md'
if (Test-Path $srcFriends) { Copy-Item $srcFriends (Join-Path $app 'START-HERE.md') }
$srcLicense = Join-Path $root 'LICENSE.txt'
if (Test-Path $srcLicense) { Copy-Item $srcLicense (Join-Path $app 'LICENSE.txt') }

# --- nothing of yours --------------------------------------------------------

$leaks = @()
$patterns = @('sk-ant-[A-Za-z0-9_-]{20,}', '"refresh_token"\s*:\s*"[^"]{10,}', 'GOCSPX-[A-Za-z0-9_-]+')
$textFiles = Get-ChildItem $app -File -Recurse | Where-Object { $textExt -contains $_.Extension.ToLower() }
foreach ($f in $textFiles) {
    $t = [System.IO.File]::ReadAllText($f.FullName)
    $rel = $f.FullName.Substring($app.Length).TrimStart('\')
    foreach ($m in $markers) {
        if ($m.Length -ge 3 -and $t.IndexOf($m, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $shown = if ($m.Length -gt 12) { $m.Substring(0, 6) + '...' } else { $m }
            $leaks += "$rel contains '$shown'"
        }
    }
    foreach ($p in $patterns) {
        # The shared client is meant to carry a client secret; Google treats a Desktop app's secret as public.
        if ($rel -eq 'engine\google-shared-client.json' -and $p -like 'GOCSPX*') { continue }
        if ($t -match $p) { $leaks += "$rel matches $p" }
    }
}
if (Test-Path (Join-Path $app 'engine\google-shared-client.json')) {
    if ($leaks | Where-Object { $_ -like 'engine\google-shared-client.json contains*' }) {
        $leaks += "engine\google-shared-client.json comes from your own Google Cloud project. Make the shared client in a separate project, so your own sign-ins stay yours."
    }
    Write-Host "Including the shared Google client, so friends can connect without making their own." -ForegroundColor Cyan
}
$forbidden = @('google-tokens.json', 'google-accounts.json', 'account.json', 'history.json', 'auto-tasks.json', 'finance.json', 'finance-brief.json', 'health.json', 'grades.json',
               'drops.json', 'ai-key.txt', 'ai-usage.json', 'news-detected.json', 'applied-state.json', 'stocks-cache.json')
foreach ($name in $forbidden) {
    Get-ChildItem $app -File -Recurse -Filter $name | ForEach-Object { $leaks += "$($_.FullName.Substring($app.Length).TrimStart('\')) should not be in the package" }
}
Get-ChildItem $app -File -Recurse -Filter 'client_secret_*' | ForEach-Object { $leaks += "$($_.Name) should not be in the package" }
Get-ChildItem $app -File -Recurse -Filter '*.log' | ForEach-Object { $leaks += "$($_.Name) should not be in the package" }

if ($leaks.Count -gt 0) {
    Write-Host "Not packaged. Something of yours would have gone out:" -ForegroundColor Red
    $leaks | Sort-Object -Unique | ForEach-Object { Write-Host "  - $_" }
    Write-Host ""
    Write-Host "The staged copy is at $stage if you want to look." -ForegroundColor Yellow
    exit 1
}

# --- zip it ------------------------------------------------------------------

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$zip = Join-Path $OutDir "Mellow-$stamp.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }

# Forward slashes and Unix permissions, so a Mac can run start-ratchet.command with a double-click.
. (Join-Path $here 'zip-tools.ps1')
Write-UnixZip -Path $zip -Entries @(Get-ZipEntries -Dir $app -Prefix 'Mellow')
Remove-Item $stage -Recurse -Force
Copy-Item $zip (Join-Path $OutDir 'Mellow.zip') -Force

$size = [math]::Round((Get-Item $zip).Length / 1KB)
Write-Host "Packaged $copied files into $zip ($size KB), version $Version." -ForegroundColor Green
Write-Host "Mellow.zip beside it is the same file, named for a GitHub release." -ForegroundColor Green
Write-Host "Checked for $($markers.Count) things of yours; none are in it." -ForegroundColor Green
Write-Host ""
Write-Host "Your friend unzips it, installs Node.js, and double-clicks start-ratchet.cmd (Windows) or start-ratchet.command (Mac)."
Write-Host "The Guide section inside Mellow walks them through the rest, including phones and tablets."
