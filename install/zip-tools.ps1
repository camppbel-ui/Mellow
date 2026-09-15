<#
  zip-tools.ps1 - writes zips a Mac unzips properly. Dot-source it:

      . (Join-Path $PSScriptRoot 'zip-tools.ps1')
      Write-UnixZip -Path out.zip -Entries @(@{ Name = 'Mellow/engine/engine.js'; File = 'C:\...\engine.js'; Mode = 0x81A4 })

  Not Compress-Archive: the version in Windows PowerShell 5.1 writes paths with
  backslashes, which a Mac unzips as files literally named "engine\engine.js".
  Entries get forward slashes and Unix permissions (0x81ED for anything that
  runs, 0x81A4 otherwise), and each is marked as made on Unix, because unzip
  tools only read permissions from entries made on Unix. Without that a Mac
  can't double-click start-ratchet.command or open Mellow.app.
#>

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$script:ModeRun = 0x81ED    # 0100755
$script:ModeFile = 0x81A4   # 0100644

function Write-UnixZip {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][object[]]$Entries)

    if (Test-Path $Path) { Remove-Item $Path -Force }
    $archive = [System.IO.Compression.ZipFile]::Open($Path, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($e in $Entries) {
            $name = $e.Name.Replace('\', '/')
            $entry = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $e.File, $name, [System.IO.Compression.CompressionLevel]::Optimal)
            $mode = if ($e.Mode) { $e.Mode } else { $script:ModeFile }
            $entry.ExternalAttributes = $mode -shl 16
        }
    } finally {
        $archive.Dispose()
    }

    # .NET Framework marks every entry "made on MS-DOS". The upper byte of
    # "version made by" in each central directory record becomes 3, Unix.
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $eocd = -1
    for ($p = $bytes.Length - 22; $p -ge [Math]::Max(0, $bytes.Length - 65557); $p--) {
        if ([BitConverter]::ToUInt32($bytes, $p) -eq 0x06054b50) { $eocd = $p; break }
    }
    if ($eocd -lt 0) { throw "Couldn't read back $Path." }
    $count = [BitConverter]::ToUInt16($bytes, $eocd + 10)
    $p = [int][BitConverter]::ToUInt32($bytes, $eocd + 16)
    for ($n = 0; $n -lt $count; $n++) {
        if ([BitConverter]::ToUInt32($bytes, $p) -ne 0x02014b50) { throw "Unexpected zip layout in $Path." }
        $bytes[$p + 5] = 3
        $p += 46 + [BitConverter]::ToUInt16($bytes, $p + 28) + [BitConverter]::ToUInt16($bytes, $p + 30) + [BitConverter]::ToUInt16($bytes, $p + 32)
    }
    [System.IO.File]::WriteAllBytes($Path, $bytes)
}

<# Every file under $Dir as entries under $Prefix; .command and .sh files can run. #>
function Get-ZipEntries {
    param([Parameter(Mandatory)][string]$Dir, [Parameter(Mandatory)][string]$Prefix)
    $Dir = (Resolve-Path $Dir).Path.TrimEnd('\')
    foreach ($f in Get-ChildItem $Dir -File -Recurse) {
        $mode = if ($f.Extension -in @('.command', '.sh')) { $script:ModeRun } else { $script:ModeFile }
        @{ Name = $Prefix.TrimEnd('/') + '/' + $f.FullName.Substring($Dir.Length).TrimStart('\').Replace('\', '/'); File = $f.FullName; Mode = $mode }
    }
}
