<#
  harden-account.ps1

  Everything else in Ratchet is defeatable in about four seconds if the account
  you use all day has admin rights: open Task Scheduler, stop the task, done.
  This is the part that closes that.

  The shape is: a separate admin account you do not live in, and a standard
  account you do. The tasks run as SYSTEM, so your daily session cannot stop
  them, edit the hosts file, or delete firewall rules without switching users
  and typing a password. That is the Windows equivalent of handing someone else
  the Screen Time passcode, except the someone else is you, ten minutes ago.

  Two steps, deliberately separate, because doing them in one go is how people
  lock themselves out.

    STEP 1 - make the backup admin (run as your current admin account):
        powershell -ExecutionPolicy Bypass -File .\install\harden-account.ps1 -CreateAdmin

    Then SIGN OUT and SIGN IN as that new account once. Actually do this. If the
    password is wrong you want to find out now, not after step 2.

    STEP 2 - demote your daily account (run as the NEW admin account):
        powershell -ExecutionPolicy Bypass -File .\install\harden-account.ps1 -MakeStandard yourname

  Both steps refuse to run if they would leave you with no way back in.
#>

param(
    [switch]$CreateAdmin,
    [string]$MakeStandard,
    [string]$AdminName = 'RatchetAdmin',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Say($msg, $color = 'White') { Write-Host $msg -ForegroundColor $color }

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
   ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Say "This needs Administrator. Right-click PowerShell -> Run as administrator." Red
    exit 1
}

# Enabled members of the local Administrators group, local accounts only.
function Get-EnabledLocalAdmins {
    $members = Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue
    $out = @()
    foreach ($m in $members) {
        if ($m.ObjectClass -ne 'User') { continue }
        $name = ($m.Name -split '\\')[-1]
        $u = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
        if ($u -and $u.Enabled) { $out += $u.Name }
    }
    return $out
}

if (-not $CreateAdmin -and -not $MakeStandard) {
    Say "Current state" Cyan
    Say ""
    Say "  You are: $env:USERNAME"
    Say "  Enabled local administrators: $((Get-EnabledLocalAdmins) -join ', ')"
    Say ""
    Say "  Run with -CreateAdmin to make the backup admin account," Yellow
    Say "  then with -MakeStandard <name> from that account to demote your daily one." Yellow
    exit 0
}

# --- STEP 1 -------------------------------------------------------------------
if ($CreateAdmin) {
    Say "Creating backup administrator '$AdminName'" Cyan

    if (Get-LocalUser -Name $AdminName -ErrorAction SilentlyContinue) {
        Say "  '$AdminName' already exists. Nothing to do." Yellow
        Say "  If you have forgotten its password, reset it in Settings before going further." Yellow
        exit 0
    }

    Say ""
    Say "  Pick a password you can actually remember but would not type absent-mindedly." Yellow
    Say "  This is the thing standing between you and Steam at 2am, so a memorable one" Yellow
    Say "  that takes ten seconds to recall is better than a random one in a manager" Yellow
    Say "  that autofills." Yellow
    Say ""

    $p1 = Read-Host "  Password for $AdminName" -AsSecureString
    $p2 = Read-Host "  Type it again" -AsSecureString

    $b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1)
    $b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2)
    try {
        $match = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b1) -ceq
                 [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b2)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
    }

    if (-not $match) { Say "  Those did not match. Nothing was created." Red; exit 1 }

    # New-LocalUser caps Description at 48 characters and throws rather than
    # truncating, so this string is deliberately short. Count before editing.
    New-LocalUser -Name $AdminName `
                  -Password $p1 `
                  -FullName 'Ratchet break-glass admin' `
                  -Description 'Ratchet admin. Not for day-to-day use.' `
                  -PasswordNeverExpires | Out-Null

    Add-LocalGroupMember -Group 'Administrators' -Member $AdminName

    Say ""
    Say "  Created '$AdminName' and added it to Administrators." Green
    Say ""
    Say "  NOW SIGN OUT AND SIGN IN AS '$AdminName' ONCE." Yellow
    Say "  Windows has to build its profile, and you want to prove the password works" Yellow
    Say "  while you still have another admin account to fall back on." Yellow
    Say ""
    Say "  Then, from that account, run:" Yellow
    Say "      powershell -ExecutionPolicy Bypass -File .\install\harden-account.ps1 -MakeStandard $env:USERNAME"
    exit 0
}

# --- STEP 2 -------------------------------------------------------------------
if ($MakeStandard) {
    $target = $MakeStandard
    Say "Demoting '$target' to a standard user" Cyan

    $user = Get-LocalUser -Name $target -ErrorAction SilentlyContinue
    if (-not $user) { Say "  No local account called '$target'." Red; exit 1 }

    $admins = Get-EnabledLocalAdmins
    if ($admins -notcontains $user.Name) {
        Say "  '$target' is already a standard user. Nothing to do." Green
        exit 0
    }

    $remaining = @($admins | Where-Object { $_ -ne $user.Name })
    if ($remaining.Count -eq 0) {
        Say ""
        Say "  REFUSING. '$target' is the only enabled administrator on this machine." Red
        Say "  Demoting it would leave you unable to install anything, clear the shield," Red
        Say "  or undo this. Run -CreateAdmin first." Red
        exit 1
    }

    if ($env:USERNAME -eq $user.Name -and -not $Force) {
        Say ""
        Say "  REFUSING. You are logged in as '$target' right now." Red
        Say "  Sign in as '$($remaining -join "' or '")' and run this from there, so you" Red
        Say "  find out immediately if that account does not work." Red
        Say "  Add -Force only if you know what you are doing." Red
        exit 1
    }

    Say ""
    Say "  Remaining administrators afterwards: $($remaining -join ', ')" Yellow
    $ans = Read-Host "  Demote '$target' now? (y/n)"
    if ($ans -ne 'y') { Say "  Cancelled. Nothing changed." Yellow; exit 0 }

    Remove-LocalGroupMember -Group 'Administrators' -Member $user.Name

    Say ""
    Say "  '$target' is now a standard user." Green
    Say ""
    Say "  What changed, in practice:" Cyan
    Say "    - Your daily session can no longer stop the Ratchet tasks."
    Say "    - It can no longer edit the hosts file or delete the firewall rules."
    Say "    - Clearing the shield now needs the '$($remaining[0])' password."
    Say "    - Installing software now needs it too. That is the cost, and it is the point."
    Say ""
    Say "  Sign out and back in as '$target' for it to take effect." Yellow
    exit 0
}
