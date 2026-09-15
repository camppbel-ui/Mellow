<#
  find-node.ps1

  Returns the full path to node.exe, or $null.

  Dot-source it; do not run it on its own:
      . (Join-Path $PSScriptRoot 'find-node.ps1')
      $node = Find-NodeExe

  Why this exists: winget installs Node and updates the machine PATH, but an
  already-open PowerShell window keeps the environment it started with. So the
  very first thing you do after installing Node fails with "not found on PATH"
  while Node sits there working perfectly. Checking the registry and the usual
  install directories costs nothing and removes a step from the instructions.
#>

function Find-NodeExe {
    # 1. Already on this session's PATH.
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }

    # 2. The machine PATH as it stands now, which this window may predate.
    $livePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')
    foreach ($dir in ($livePath -split ';')) {
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        $candidate = Join-Path $dir.Trim() 'node.exe'
        if (Test-Path $candidate) { return $candidate }
    }

    # 3. Where the official installer puts it.
    foreach ($candidate in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }

    # 4. Whatever the installer recorded about itself.
    $key = 'HKLM:\SOFTWARE\Node.js'
    if (Test-Path $key) {
        $installPath = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).InstallPath
        if ($installPath) {
            $candidate = Join-Path $installPath 'node.exe'
            if (Test-Path $candidate) { return $candidate }
        }
    }

    return $null
}
