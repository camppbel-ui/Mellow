<#
  use-mellow-app.ps1

  Runs your own Mellow with the Windows app instead of the Ratchet-Engine task:
  Mellow's own window, its icon by the clock, and starting when you sign in.
  Mellow keeps running from this folder, with your data where it is and the
  Node.js you already have. No admin for this part.

      powershell -ExecutionPolicy Bypass -File .\install\use-mellow-app.ps1
      powershell -ExecutionPolicy Bypass -File .\install\use-mellow-app.ps1 -Undo

  What it does:
    - copies Mellow.exe and the WebView2 DLLs from dist\Mellow-Windows.zip
      (built by build-apps.ps1) into this folder
    - makes Desktop and Start menu shortcuts called Mellow, replacing the two
      Ratchet.lnk shortcuts that opened localhost:7777 in Chrome
    - starts Mellow when you sign in (Settings > Apps > Startup shows it)
    - opens it

  While the Ratchet-Engine task still runs, the app just shows that engine. To
  have the app run the engine itself, an ADMINISTRATOR PowerShell stops the
  task (this script prints the commands). After that Mellow starts when you
  sign in rather than when the PC boots, so your phone reaches it once you're
  signed in.

  -Undo takes the shortcuts and sign-in entry away again, puts the Ratchet
  shortcut back, and prints the commands that turn the task back on.
#>

param([switch]$Undo)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$exe = Join-Path $root 'Mellow.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$shell = New-Object -ComObject WScript.Shell

function New-Shortcut($path, $target, $arguments, $icon) {
    $sc = $shell.CreateShortcut($path)
    $sc.TargetPath = $target
    $sc.Arguments = $arguments
    $sc.WorkingDirectory = $root
    $sc.IconLocation = "$icon,0"
    $sc.Description = 'Mellow'
    $sc.Save()
    Write-Host "  made $path"
}

# The app's quit signal is named after its folder, the same way Mellow.exe names it.
function Stop-MellowApp {
    $running = Get-Process Mellow -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
    if (-not $running) { return }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $id = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.TrimEnd('\').ToLowerInvariant()))).Replace('-', '')).Substring(0, 12)
    $created = $false
    $quit = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, "Local\Mellow-quit-$id", [ref]$created)
    [void]$quit.Set()
    $running | ForEach-Object { [void]$_.WaitForExit(15000) }
    Write-Host "  closed the running Mellow app"
}

if ($Undo) {
    Stop-MellowApp
    foreach ($lnk in @((Join-Path $desktop 'Mellow.lnk'), (Join-Path $programs 'Mellow.lnk'))) {
        if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "  removed $lnk" }
    }
    if ((Get-ItemProperty $runKey -Name Mellow -ErrorAction SilentlyContinue)) { Remove-ItemProperty $runKey -Name Mellow; Write-Host "  Mellow no longer starts when you sign in" }
    & (Join-Path $here 'make-desktop-app.ps1') | Out-Null
    Write-Host "  put the Ratchet shortcuts back"
    Write-Host ""
    Write-Host "Now, in an ADMINISTRATOR PowerShell, turn the engine task back on:" -ForegroundColor Yellow
    Write-Host "  Enable-ScheduledTask -TaskName Ratchet-Engine; Start-ScheduledTask -TaskName Ratchet-Engine"
    exit 0
}

$zip = Join-Path $root 'dist\Mellow-Windows.zip'
if (-not (Test-Path $zip)) { Write-Host "No $zip yet. Run install\build-apps.ps1 (or prepare-release.ps1) first." -ForegroundColor Red; exit 1 }

Stop-MellowApp
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
    foreach ($name in @('Mellow.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')) {
        $entry = $archive.Entries | Where-Object { $_.FullName -eq "Mellow/$name" }
        if (-not $entry) { throw "$name isn't in $zip. Rebuild it with build-apps.ps1." }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $root $name), $true)
        Write-Host "  copied $name"
    }
} finally { $archive.Dispose() }

# The Ratchet shortcuts opened localhost:7777 in Chrome; Mellow.lnk replaces them. Only ones that do exactly that are removed.
foreach ($old in @((Join-Path $desktop 'Ratchet.lnk'), (Join-Path $programs 'Ratchet.lnk'))) {
    if (-not (Test-Path $old)) { continue }
    $sc = $shell.CreateShortcut($old)
    if ($sc.Arguments -match '--app=http://localhost:\d+/?$') { Remove-Item $old -Force; Write-Host "  removed $old" }
}
New-Shortcut (Join-Path $desktop 'Mellow.lnk') $exe '' $exe
New-Shortcut (Join-Path $programs 'Mellow.lnk') $exe '' $exe
Set-ItemProperty $runKey -Name Mellow -Value "`"$exe`" --background"
Write-Host "  Mellow starts when you sign in"

Start-Process $exe -WorkingDirectory $root
Write-Host ""
Write-Host "Mellow is open in its own window." -ForegroundColor Green
Write-Host ""
Write-Host "Last step, so the app runs the engine instead of the Ratchet-Engine task." -ForegroundColor Yellow
Write-Host "In an ADMINISTRATOR PowerShell:"
Write-Host "  Stop-ScheduledTask -TaskName Ratchet-Engine; Disable-ScheduledTask -TaskName Ratchet-Engine"
Write-Host "Then right-click Mellow's icon by the clock, Quit Mellow, and open Mellow from the desktop."
