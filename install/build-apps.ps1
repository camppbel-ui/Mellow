<#
  build-apps.ps1

  Builds the Windows and Mac apps friends download from mellow-track.com, from
  the package package-for-friends.ps1 made. prepare-release.ps1 runs it for you.

      powershell -ExecutionPolicy Bypass -File .\install\build-apps.ps1

  Writes, beside dist\Mellow.zip:
    Mellow-Windows.zip   Mellow.exe, Node.js, and Mellow's code. Double-clicking
                         Mellow installs it to %LOCALAPPDATA%\Mellow with a desktop
                         and Start menu icon, and runs it from the notification area.
    Mellow-Mac.zip       Mellow.app, with Node.js for Apple silicon and Intel. It
                         installs itself to ~/Library/Application Support/Mellow.

  Neither needs Node.js installed. Both run the same code as Mellow.zip, and
  Mellow.zip stays what every copy's updater downloads, so friends download an
  app once and updates arrive in it after that. Attach all three to the release.

  Node.js comes from nodejs.org, pinned to the version below, checked against
  its published SHA-256 sums, and kept in dist\node-cache so it downloads once.

      -OutDir <path>        where Mellow.zip is and the apps go (default: dist\)
      -NodeVersion <v>      like v24.21.0 (default below; change it on purpose)
#>

param([string]$OutDir, [string]$NodeVersion = 'v24.21.0')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower drawing its progress bar

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
. (Join-Path $here 'zip-tools.ps1')

$zip = Join-Path $OutDir 'Mellow.zip'
if (-not (Test-Path $zip)) { Write-Host "No $zip yet. Run package-for-friends.ps1 (or prepare-release.ps1) first." -ForegroundColor Red; exit 1 }

$work = Join-Path ([System.IO.Path]::GetTempPath()) "mellow-apps-$([guid]::NewGuid().ToString('N').Substring(0, 6))"
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
    # --- Mellow's code, as released ------------------------------------------------
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $work)
    $code = Join-Path $work 'Mellow'
    $version = (([System.IO.File]::ReadAllText((Join-Path $code 'engine\version.json'))).TrimStart([char]0xFEFF) | ConvertFrom-Json).version
    Write-Host "Mellow $version"

    # --- Node.js, checked ------------------------------------------------------------
    $cache = Join-Path $OutDir "node-cache\$NodeVersion"
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $base = "https://nodejs.org/dist/$NodeVersion"
    $sumsFile = Join-Path $cache 'SHASUMS256.txt'
    if (-not (Test-Path $sumsFile)) { Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile $sumsFile -UseBasicParsing }
    $sums = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($sumsFile)) { if ($line -match '^([0-9a-f]{64})\s+(\S+)$') { $sums[$Matches[2]] = $Matches[1] } }

    function Get-Node([string]$file) {
        $dst = Join-Path $cache $file
        if (-not $sums.ContainsKey($file)) { throw "$file isn't in Node's SHASUMS256.txt for $NodeVersion." }
        if ((Test-Path $dst) -and (Get-FileHash $dst -Algorithm SHA256).Hash.ToLower() -eq $sums[$file]) { return $dst }
        Write-Host "  downloading $file"
        Invoke-WebRequest "$base/$file" -OutFile "$dst.part" -UseBasicParsing
        $got = (Get-FileHash "$dst.part" -Algorithm SHA256).Hash.ToLower()
        if ($got -ne $sums[$file]) { Remove-Item "$dst.part" -Force; throw "$file didn't match nodejs.org's checksum, so it wasn't used." }
        Move-Item "$dst.part" $dst -Force
        return $dst
    }

    $winNodeZip = Get-Node "node-$NodeVersion-win-x64.zip"
    $macArm = Get-Node "node-$NodeVersion-darwin-arm64.tar.gz"
    $macX64 = Get-Node "node-$NodeVersion-darwin-x64.tar.gz"

    $rt = Join-Path $work 'runtime'
    New-Item -ItemType Directory -Path $rt -Force | Out-Null
    $nodeZip = [System.IO.Compression.ZipFile]::OpenRead($winNodeZip)
    try {
        $entry = $nodeZip.Entries | Where-Object { $_.FullName -eq "node-$NodeVersion-win-x64/node.exe" }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $rt 'node.exe'), $true)
    } finally { $nodeZip.Dispose() }
    foreach ($a in @(@{ arch = 'arm64'; file = $macArm }, @{ arch = 'x64'; file = $macX64 })) {
        $inner = "node-$NodeVersion-darwin-$($a.arch)/bin/node"
        & "$env:SystemRoot\System32\tar.exe" -xzf $a.file -C $rt $inner
        if ($LASTEXITCODE -ne 0) { throw "Couldn't unpack $inner." }
        Move-Item (Join-Path $rt ($inner.Replace('/', '\'))) (Join-Path $rt "node-$($a.arch)")
    }

    # --- Mellow.exe --------------------------------------------------------------------
    $csc = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path $csc)) { throw "The C# compiler that comes with Windows isn't at $csc." }
    $exe = Join-Path $work 'Mellow.exe'
    $out = & $csc /nologo /target:winexe /optimize+ "/win32icon:$(Join-Path $root 'ratchet.ico')" "/out:$exe" `
        /reference:System.Windows.Forms.dll /reference:System.Drawing.dll (Join-Path $here 'app\windows\Mellow.cs')
    if ($LASTEXITCODE -ne 0) { $out | ForEach-Object { Write-Host $_ }; throw "Mellow.exe didn't compile." }

    # --- Mellow-Windows.zip --------------------------------------------------------------
    $readme = Join-Path $work 'Read me.txt'
    [System.IO.File]::WriteAllText($readme, (@"
Mellow $version for Windows

Double-click Mellow to install it. It puts Mellow on your desktop and in the
Start menu and opens it in its own window. Nothing else to install.

If Windows says it protected your PC, click More info, then Run anyway.

After that you can delete this folder and the zip. Mellow updates itself:
when a new version is out, Update now appears in its sidebar.

While Mellow runs, its icon sits by the clock (click the ^ arrow if you don't
see it). Click it to open Mellow; right-click it to quit or to start Mellow
when you sign in.

https://mellow-track.com
"@).Replace("`r`n", "`n").Replace("`n", "`r`n"), (New-Object System.Text.UTF8Encoding $false))

    $winEntries = @(
        @{ Name = 'Mellow/Mellow.exe'; File = $exe },
        @{ Name = 'Mellow/Read me.txt'; File = $readme },
        @{ Name = 'Mellow/runtime/node.exe'; File = (Join-Path $rt 'node.exe') }
    ) + @(Get-ZipEntries -Dir $code -Prefix 'Mellow/app')
    $winZip = Join-Path $OutDir 'Mellow-Windows.zip'
    Write-UnixZip -Path $winZip -Entries $winEntries

    # --- Mellow.app ----------------------------------------------------------------------
    $mac = Join-Path $work 'mac'
    New-Item -ItemType Directory -Path $mac -Force | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $lf = { param($src, $dst) [System.IO.File]::WriteAllText($dst, ([System.IO.File]::ReadAllText($src)).Replace("`r`n", "`n"), $utf8) }
    & $lf (Join-Path $here 'app\mac\Mellow') (Join-Path $mac 'Mellow')
    & $lf (Join-Path $here 'app\mac\supervise.sh') (Join-Path $mac 'supervise.sh')
    [System.IO.File]::WriteAllText((Join-Path $mac 'Info.plist'), ([System.IO.File]::ReadAllText((Join-Path $here 'app\mac\Info.plist'))).Replace('@VERSION@', $version).Replace("`r`n", "`n"), $utf8)

    # Mellow.icns: PNGs at 128, 256 and 512 (and 512 again as 256@2x), from the app's own icon.
    Add-Type -AssemblyName System.Drawing
    $src512 = [System.Drawing.Image]::FromFile((Join-Path $root 'engine\icon-512.png'))
    function Get-Png([int]$size) {
        $bmp = New-Object System.Drawing.Bitmap $size, $size
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($src512, 0, 0, $size, $size)
        $g.Dispose()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        return , $ms.ToArray()
    }
    $icons = [ordered]@{ 'ic07' = (Get-Png 128); 'ic08' = (Get-Png 256); 'ic09' = (Get-Png 512); 'ic13' = (Get-Png 512) }
    $src512.Dispose()
    $icns = New-Object System.IO.MemoryStream
    $beInt = { param([int]$n) $b = [BitConverter]::GetBytes($n); [Array]::Reverse($b); , $b }
    $total = 8
    foreach ($v in $icons.Values) { $total += 8 + $v.Length }
    $icns.Write([Text.Encoding]::ASCII.GetBytes('icns'), 0, 4); $icns.Write((& $beInt $total), 0, 4)
    foreach ($k in $icons.Keys) {
        $icns.Write([Text.Encoding]::ASCII.GetBytes($k), 0, 4); $icns.Write((& $beInt (8 + $icons[$k].Length)), 0, 4)
        $icns.Write($icons[$k], 0, $icons[$k].Length)
    }
    [System.IO.File]::WriteAllBytes((Join-Path $mac 'Mellow.icns'), $icns.ToArray())

    $c = 'Mellow.app/Contents'
    $macEntries = @(
        @{ Name = "$c/Info.plist"; File = (Join-Path $mac 'Info.plist') },
        @{ Name = "$c/MacOS/Mellow"; File = (Join-Path $mac 'Mellow'); Mode = $script:ModeRun },
        @{ Name = "$c/Resources/Mellow.icns"; File = (Join-Path $mac 'Mellow.icns') },
        @{ Name = "$c/Resources/supervise.sh"; File = (Join-Path $mac 'supervise.sh'); Mode = $script:ModeRun },
        @{ Name = "$c/Resources/runtime/node-arm64"; File = (Join-Path $rt 'node-arm64'); Mode = $script:ModeRun },
        @{ Name = "$c/Resources/runtime/node-x64"; File = (Join-Path $rt 'node-x64'); Mode = $script:ModeRun }
    ) + @(Get-ZipEntries -Dir $code -Prefix "$c/Resources/app")
    $macZip = Join-Path $OutDir 'Mellow-Mac.zip'
    Write-UnixZip -Path $macZip -Entries $macEntries

    foreach ($z in @($winZip, $macZip)) {
        Write-Host ("Built {0} ({1} MB)" -f (Split-Path -Leaf $z), [math]::Round((Get-Item $z).Length / 1MB, 1)) -ForegroundColor Green
    }
    Write-Host "Node.js $NodeVersion inside. Attach both, and Mellow.zip, to the release under exactly these names."
} finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
