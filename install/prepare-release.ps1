<#
  prepare-release.ps1

  Gets a new version of Mellow ready to publish on GitHub and mellow-track.com.

      powershell -ExecutionPolicy Bypass -File .\install\prepare-release.ps1
      powershell -ExecutionPolicy Bypass -File .\install\prepare-release.ps1 -Version 2026.09.20.2

  What it does:
    1. Builds the friends package (install\package-for-friends.ps1), which
       stamps the version and checks nothing of yours is in it.
    2. Fills your clone of github.com/camppbel-ui/Mellow with that package's
       files, and the website (site\) as docs\, which GitHub Pages serves at
       mellow-track.com. Your data never goes in: only what the package has.
    3. Builds the Windows and Mac apps (install\build-apps.ps1) from that package.
    4. Writes RELEASE-NOTES.txt with the tag to use, and leaves Mellow.zip,
       Mellow-Setup.exe, Mellow-Windows.zip and Mellow-Mac.zip in dist\ to attach.

  Then you commit and push (GitHub Desktop), and publish a release with all
  four attached. Every friend's Mellow sees it within a few hours.

      -Version <v>     like 2026.09.20; default today's date
      -RepoDir <path>  your clone of the repo (default: D:\Assistant Tool\mellow-repo)
#>

param([string]$Version, [string]$RepoDir = 'D:\Assistant Tool\mellow-repo')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
if (-not $Version) { $Version = Get-Date -Format 'yyyy.MM.dd' }

$RepoDir = [System.IO.Path]::GetFullPath($RepoDir)
if ($RepoDir.TrimEnd('\') -ieq $root.TrimEnd('\') -or $RepoDir.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "The repo folder can't be inside your own Mellow folder: that is where your data lives." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $RepoDir '.git'))) {
    Write-Host "No clone of the repo at $RepoDir yet." -ForegroundColor Yellow
    Write-Host "In GitHub Desktop: File > Clone repository > camppbel-ui/Mellow, Local path: $RepoDir"
    Write-Host "Then run this again."
    exit 1
}

# --- 1. the package -------------------------------------------------------------
$dist = Join-Path $root 'dist'
& powershell -ExecutionPolicy Bypass -File (Join-Path $here 'package-for-friends.ps1') -OutDir $dist -Version $Version
if ($LASTEXITCODE -ne 0) { Write-Host "The package wasn't built, so nothing else was done." -ForegroundColor Red; exit 1 }
$zip = Join-Path $dist 'Mellow.zip'

# The Windows and Mac apps friends download, built from that same package.
& powershell -ExecutionPolicy Bypass -File (Join-Path $here 'build-apps.ps1') -OutDir $dist
if ($LASTEXITCODE -ne 0) { Write-Host "The apps weren't built, so nothing else was done." -ForegroundColor Red; exit 1 }
$setupExe = Join-Path $dist 'Mellow-Setup.exe'
$winZip = Join-Path $dist 'Mellow-Windows.zip'
$macZip = Join-Path $dist 'Mellow-Mac.zip'

# --- 2. the repo ------------------------------------------------------------------
Add-Type -AssemblyName System.IO.Compression.FileSystem
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "mellow-release-$([guid]::NewGuid().ToString('N').Substring(0, 6))"
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
$src = Join-Path $tmp 'Mellow'

# Everything but .git is replaced, so files removed from Mellow leave the repo too.
Get-ChildItem $RepoDir -Force | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force
Get-ChildItem $src -Force | ForEach-Object { Copy-Item $_.FullName (Join-Path $RepoDir $_.Name) -Recurse -Force }
Remove-Item $tmp -Recurse -Force

$site = Join-Path $root 'site'
if (Test-Path $site) {
    $docs = Join-Path $RepoDir 'docs'
    New-Item -ItemType Directory -Path $docs -Force | Out-Null
    Get-ChildItem $site -Force | ForEach-Object { Copy-Item $_.FullName (Join-Path $docs $_.Name) -Recurse -Force }
}

$utf8 = New-Object System.Text.UTF8Encoding $false
# If a friend runs Mellow from a clone instead of the zip, their data stays out of git.
[System.IO.File]::WriteAllText((Join-Path $RepoDir '.gitignore'), @'
# Your data, sign-ins and keys, if you run Mellow from this folder
engine/*.json
!engine/version.json
!engine/google.json
!engine/calendars.json
!engine/tasks.json
!engine/stocks.json
!engine/news.json
!engine/ai.json
!engine/engine-config.json
engine/ai-key.txt
engine/client_secret_*
engine/google-tokens.json
engine/assistant/
engine/drops/
engine/google-cache/
engine/*-cache/
engine/*.tmp
*.log
*.new
*.updating
dist/
notify-queue/
applied-state.json
'@, $utf8)

$tag = "v$Version"
$notes = Join-Path $root 'dist\RELEASE-NOTES.txt'
[System.IO.File]::WriteAllText($notes, @"
Tag:    $tag
Title:  Mellow $Version
Files:  $zip
        $setupExe
        $winZip
        $macZip

What's new (edit this, then paste it into the release description; each line starting with - shows in Mellow and on the website):
-
-
-
"@, $utf8)

Write-Host ""
Write-Host "Ready: Mellow $Version" -ForegroundColor Green
Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  1. GitHub Desktop: commit to main (summary: Mellow $Version), then Push origin."
Write-Host "  2. github.com/camppbel-ui/Mellow/releases/new"
Write-Host "       Choose a tag: $tag   (create new tag on publish)"
Write-Host "       Title: Mellow $Version"
Write-Host "       Description: what's new, one '- ' line each"
Write-Host "       Attach all four, keeping these exact names:"
Write-Host "         $zip          (every copy's updater downloads this)"
Write-Host "         $setupExe    (the Windows download)"
Write-Host "         $winZip  (the Windows app unzipped, if an installer is blocked)"
Write-Host "         $macZip      (the Mac app)"
Write-Host "       Publish release"
Write-Host ""
Write-Host "Notes template: $notes"
