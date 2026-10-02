# make-doctor-icon.ps1 - build a DeepSeek + red-cross folder icon.
# deepseek.ico uses PNG-compressed entries, which break System.Drawing.Icon;
# so we parse the ICO container ourselves and decode the biggest PNG entry.
# Outputs:
#   D:\dhs01\dsh-plugin-tools\doctor-folder.ico          (classic BMP-entry ICO, 256x256)
#   D:\dhs01\dsh-plugin-tools\doctor-folder-preview.png  (visual preview)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File make-doctor-icon.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$srcIco = 'D:\dhs01\dsh-desktop\deepseek.ico'
$outIco = 'D:\dhs01\dsh-plugin-tools\doctor-folder.ico'
$outPng = 'D:\dhs01\dsh-plugin-tools\doctor-folder-preview.png'

# --- parse ICO: pick the largest PNG entry -------------------------------
$bytes = [System.IO.File]::ReadAllBytes($srcIco)
$count = [BitConverter]::ToUInt16($bytes, 4)
$best = $null   # @{w;h;off;size}
for ($i = 0; $i -lt $count; $i++) {
    $off = 6 + $i * 16
    $w = $bytes[$off]; $h = $bytes[$off + 1]
    $size = [BitConverter]::ToUInt32($bytes, $off + 8)
    $dataOff = [BitConverter]::ToUInt32($bytes, $off + 12)
    $dim = if ($w -eq 0) { 256 } else { [int]$w }
    if (-not $best -or $dim -gt $best.w) {
        $best = @{ w = $dim; off = [int]$dataOff; size = [int]$size }
    }
}
if (-not $best) { throw 'no icon entry found' }
$pngBytes = New-Object byte[] $best.size
[System.Array]::Copy($bytes, $best.off, $pngBytes, 0, $best.size)
$ms = New-Object System.IO.MemoryStream(,$pngBytes)
$src = New-Object System.Drawing.Bitmap($ms)
Write-Output ("source entry: " + $best.w + "x" + $best.w + " (" + $best.size + " bytes)")

# --- paint the composite -------------------------------------------------
$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($src, 0, 0, $size, $size)

$cx = 196; $cy = 196; $r = 52
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
$g.FillEllipse($white, $cx - $r, $cy - $r, 2 * $r, 2 * $r)
$red = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 222, 36, 52))
$armW = 30; $armL = 92
$g.FillRectangle($red, $cx - $armL / 2, $cy - $armW / 2, $armL, $armW)
$g.FillRectangle($red, $cx - $armW / 2, $cy - $armL / 2, $armW, $armL)
$white.Dispose(); $red.Dispose()
$g.Dispose(); $src.Dispose(); $ms.Dispose()

$bmp.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)

# --- classic 32bpp ICO entry (BGRA bottom-up + AND mask) ------------------
$pixels = New-Object byte[] ($size * $size * 4)
$data = $bmp.LockBits((New-Object System.Drawing.Rectangle(0, 0, $size, $size)),
    [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
$bmp.UnlockBits($data)
$bmp.Dispose()

$bw = New-Object System.IO.BinaryWriter((New-Object System.IO.MemoryStream))
$bw.Write([int32]40); $bw.Write([int32]$size); $bw.Write([int32]($size * 2))
$bw.Write([int16]1); $bw.Write([int16]32); $bw.Write([int32]0)
$bw.Write([int32]($size * $size * 4)); $bw.Write([int32]0); $bw.Write([int32]0)
$bw.Write([int32]0); $bw.Write([int32]0)
$bih = $bw.BaseStream.ToArray()
$bw.Close()

$rowBytes = $size * 4
$flipped = New-Object byte[] $pixels.Length
for ($y = 0; $y -lt $size; $y++) {
    [System.Array]::Copy($pixels, ($size - 1 - $y) * $rowBytes, $flipped, $y * $rowBytes, $rowBytes)
}
$maskRowBytes = [int]([Math]::Ceiling($size / 32.0) * 4)
$andMask = New-Object byte[] ($maskRowBytes * $size)
$entrySize = 40 + $flipped.Length + $andMask.Length

$fs = [System.IO.File]::Create($outIco)
$fw = New-Object System.IO.BinaryWriter($fs)
$fw.Write([uint16]0); $fw.Write([uint16]1); $fw.Write([uint16]1)
$fw.Write([byte]0); $fw.Write([byte]0); $fw.Write([byte]0); $fw.Write([byte]0)
$fw.Write([uint16]1); $fw.Write([uint16]32)
$fw.Write([uint32]$entrySize); $fw.Write([uint32]22)
$fw.Write($bih); $fw.Write($flipped); $fw.Write($andMask)
$fw.Close(); $fs.Close()

Write-Output "created: $outIco ($((Get-Item $outIco).Length) bytes)"
Write-Output "created: $outPng"
