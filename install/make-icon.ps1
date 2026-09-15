<#
  make-icon.ps1

  Draws the Mellow icon (still written as ratchet.ico, which the shortcuts point at) for Windows, and the PNGs the dashboard serves to phones so
  it can be added to a Home Screen. Run it only if you want to change the look;
  the output is committed alongside it, so a normal install never needs this.

      powershell -ExecutionPolicy Bypass -File .\install\make-icon.ps1

  Windows picks a different size depending on where the icon appears - 16px in
  the taskbar, 32px on the desktop, 256px in the large-icon view - so each is
  drawn separately rather than scaled from one. A 256px design shrunk to 16px
  turns to mush.
#>

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$root      = Split-Path -Parent $here
$out       = Join-Path $root 'ratchet.ico'
$engineDir = Join-Path $root 'engine'

# The same blue as the dashboard's app bar.
$BRAND = [System.Drawing.Color]::FromArgb(255, 29, 95, 209)

<#
  One icon at one size. `padded` is false for the Home Screen PNGs: iOS draws
  its own rounded mask over the full square, so leaving our own margin inside it
  produces a small crest floating in a big coloured tile.
#>
function New-RatchetBitmap {
    param([int]$Size, [bool]$Padded = $true)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Light blue at the top left into deep blue at the bottom right.
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, 0)), (New-Object System.Drawing.PointF($Size, $Size)),
        [System.Drawing.Color]::FromArgb(255, 106, 166, 255), [System.Drawing.Color]::FromArgb(255, 23, 69, 201))
    $blend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
    $blend.Colors = @([System.Drawing.Color]::FromArgb(255, 106, 166, 255), $BRAND, [System.Drawing.Color]::FromArgb(255, 23, 69, 201))
    $blend.Positions = @(0.0, 0.55, 1.0)
    $brush.InterpolationColors = $blend

    if ($Padded) {
        $pad = [Math]::Max(1, [int]($Size * 0.06))
        $r   = [Math]::Max(2, [int]($Size * 0.22))
        $box = New-Object System.Drawing.Rectangle($pad, $pad, ($Size - 2 * $pad), ($Size - 2 * $pad))

        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $d = $r * 2
        $path.AddArc($box.X, $box.Y, $d, $d, 180, 90)
        $path.AddArc($box.Right - $d, $box.Y, $d, $d, 270, 90)
        $path.AddArc($box.Right - $d, $box.Bottom - $d, $d, $d, 0, 90)
        $path.AddArc($box.X, $box.Bottom - $d, $d, $d, 90, 90)
        $path.CloseFigure()
        $g.FillPath($brush, $path)
    } else {
        $pad = 0
        $g.FillRectangle($brush, 0, 0, $Size, $Size)
    }

    # Mellow: one lowercase m, drawn as a single rounded white line so it stays
    # crisp at 16px. The same shape as the logo in the dashboard (a 100-unit box).
    $k = $Size / 100.0
    $stroke = $(if ($Size -le 16) { 13 } elseif ($Size -le 32) { 11 } else { 9 })
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([float]($stroke * $k))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $m = New-Object System.Drawing.Drawing2D.GraphicsPath
    $m.AddLine([float](28 * $k), [float](66 * $k), [float](28 * $k), [float](47 * $k))
    $m.AddArc([float](28 * $k), [float](36 * $k), [float](22 * $k), [float](22 * $k), 180, 180)
    $m.AddLine([float](50 * $k), [float](47 * $k), [float](50 * $k), [float](66 * $k))
    $g.DrawPath($pen, $m)
    $m2 = New-Object System.Drawing.Drawing2D.GraphicsPath
    $m2.AddArc([float](50 * $k), [float](36 * $k), [float](22 * $k), [float](22 * $k), 180, 180)
    $m2.AddLine([float](72 * $k), [float](47 * $k), [float](72 * $k), [float](66 * $k))
    $g.DrawPath($pen, $m2)
    $pen.Dispose(); $m.Dispose(); $m2.Dispose()

    $g.Dispose()
    return $bmp
}

<#
  A raw DIB icon entry. GDI+ cannot decode a PNG-compressed icon entry at all,
  and it is not the only thing that cannot, so every size below 256 stays in the
  format Windows has read since 1995.
#>
function ConvertTo-IconDib {
    param([System.Drawing.Bitmap]$Bitmap)

    $size = $Bitmap.Width
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $data = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                             [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $pixels = New-Object Byte[] ($stride * $size)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
    $Bitmap.UnlockBits($data)

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)

    # BITMAPINFOHEADER. Height is doubled because the structure describes the
    # colour bitmap and the AND mask stacked together.
    $bw.Write([UInt32]40)
    $bw.Write([Int32]$size)
    $bw.Write([Int32]($size * 2))
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]0)          # BI_RGB
    $bw.Write([UInt32]0)          # biSizeImage, allowed to be 0
    $bw.Write([Int32]0); $bw.Write([Int32]0)
    $bw.Write([UInt32]0); $bw.Write([UInt32]0)

    for ($y = $size - 1; $y -ge 0; $y--) { $bw.Write($pixels, $y * $stride, $size * 4) }

    # AND mask, all zeros. Alpha already carries transparency, but the mask has
    # to be present and its rows padded to 4 bytes.
    $maskRow = [int]((([int][Math]::Ceiling($size / 8.0)) + 3) -band -bnot 3)
    $zeroRow = New-Object Byte[] $maskRow
    for ($y = 0; $y -lt $size; $y++) { $bw.Write($zeroRow) }

    $bw.Flush()
    $bytes = $ms.ToArray()
    $bw.Dispose(); $ms.Dispose()
    return , $bytes
}

# --- the .ico ----------------------------------------------------------------
$sizes = @(16, 32, 48, 64, 128, 256)
$entries = @()

foreach ($size in $sizes) {
    $bmp = New-RatchetBitmap -Size $size -Padded $true
    if ($size -ge 256) {
        # Only the largest entry is PNG-compressed. Raw would add a quarter of
        # a megabyte for no visible gain.
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $entries += , $ms.ToArray()
        $ms.Dispose()
    } else {
        $entries += , (ConvertTo-IconDib -Bitmap $bmp)
    }
    $bmp.Dispose()
}

$fs = New-Object System.IO.FileStream($out, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)

$bw.Write([UInt16]0)               # reserved
$bw.Write([UInt16]1)               # type 1 = icon
$bw.Write([UInt16]$sizes.Count)

$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $dim = $(if ($s -ge 256) { 0 } else { $s })   # 0 means 256 in the directory
    $bw.Write([Byte]$dim)
    $bw.Write([Byte]$dim)
    $bw.Write([Byte]0)             # palette count
    $bw.Write([Byte]0)             # reserved
    $bw.Write([UInt16]1)           # colour planes
    $bw.Write([UInt16]32)          # bits per pixel
    $bw.Write([UInt32]$entries[$i].Length)
    $bw.Write([UInt32]$offset)
    $offset += $entries[$i].Length
}
foreach ($e in $entries) { $bw.Write($e) }

$bw.Flush(); $bw.Dispose(); $fs.Dispose()
Write-Host "Wrote $out ($((Get-Item $out).Length) bytes, $($sizes.Count) sizes)" -ForegroundColor Green

# --- the PNGs the dashboard serves to phones ---------------------------------
foreach ($spec in @(
    @{ Name = 'icon-180.png'; Size = 180; Padded = $false },   # iOS Home Screen
    @{ Name = 'icon-192.png'; Size = 192; Padded = $true  },   # Android manifest
    @{ Name = 'icon-512.png'; Size = 512; Padded = $true  },   # splash and stores
    @{ Name = 'favicon.png';  Size = 64;  Padded = $true  }
)) {
    $bmp = New-RatchetBitmap -Size $spec.Size -Padded $spec.Padded
    $path = Join-Path $engineDir $spec.Name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Wrote $path" -ForegroundColor Green
}
