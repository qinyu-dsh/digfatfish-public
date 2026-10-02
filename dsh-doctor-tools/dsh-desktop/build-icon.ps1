# Build deepseek.ico (white DeepSeek mark on a dark rounded square) from the
# official DSH favicon.svg and apply it to the desktop/startup shortcuts.
# Re-runnable: run it again after dsh updates.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File build-icon.ps1 [-NoShortcut]
param([switch]$NoShortcut)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcSvg = Join-Path $dir 'deepseek.svg'
$markSvg = Join-Path $dir 'deepseek-mark.svg'
$wrapHtml = Join-Path $dir 'render.html'
$rawPng = Join-Path $dir 'render-raw.png'
$finalPng = Join-Path $dir 'deepseek-256.png'
$ico = Join-Path $dir 'deepseek.ico'

# 1) keep a copy of the official favicon (locate via env vars, no hardcoded user name)
if (-not (Test-Path $srcSvg)) {
    $favicon = Get-ChildItem "$env:APPDATA\npm\node_modules" -Recurse -Filter 'favicon.svg' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'dsh-web-frontend' } | Select-Object -First 1
    if (-not $favicon) { throw 'favicon.svg not found under the global dsh install' }
    Copy-Item $favicon.FullName $srcSvg
}

# 2) patch the SVG: render size 512, force a white mark (drop the dark-mode media query)
$svg = Get-Content $srcSvg -Raw -Encoding UTF8
$svg = $svg -replace 'width="50\.000000" height="50\.000000"', 'width="512" height="512"'
$svg = $svg -replace '(?s)<style>.*?</style>', '<style>path { fill: #ffffff; }</style>'
Set-Content -Path $markSvg -Value $svg -Encoding UTF8

# 3) wrapper page: black background so the white mark can be keyed out later
$html = '<html><head><style>html,body{margin:0;padding:0;overflow:hidden;background:#000000}</style></head><body><img src="deepseek-mark.svg" width="512" height="512"></body></html>'
Set-Content -Path $wrapHtml -Value $html -Encoding ASCII

# 4) render with Edge headless (Edge may print harmless stderr warnings; do not abort on them)
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
if (Test-Path $rawPng) { Remove-Item $rawPng }
$url = 'file:///' + ($wrapHtml -replace '\\', '/')
$oldEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $edge --headless=new --disable-gpu --hide-scrollbars "--screenshot=$rawPng" --window-size=512,512 $url 2>$null | Out-Null
Start-Sleep -Seconds 1
if (-not (Test-Path $rawPng)) {
    & $edge --headless --disable-gpu --hide-scrollbars "--screenshot=$rawPng" --window-size=512,512 $url 2>$null | Out-Null
    Start-Sleep -Seconds 1
}
$ErrorActionPreference = $oldEap
if (-not (Test-Path $rawPng)) { throw 'Edge headless failed to produce the PNG' }

# 5) key out the black background: alpha = min(r,g,b), keep the mark white
$raw = [System.Drawing.Bitmap]::FromFile($rawPng)
$mark = New-Object System.Drawing.Bitmap 256, 256, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
for ($y = 0; $y -lt 256; $y++) {
    for ($x = 0; $x -lt 256; $x++) {
        $sx = [int]($x * ($raw.Width / 256.0)); $sy = [int]($y * ($raw.Height / 256.0))
        $p = $raw.GetPixel($sx, $sy)
        $a = [math]::Min($p.R, [math]::Min($p.G, $p.B))
        $mark.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($a, 255, 255, 255))
    }
}
$raw.Dispose()

# 6) composite onto a dark rounded square (slate-900, 22% corner radius)
$canvas = New-Object System.Drawing.Bitmap 256, 256, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$gp = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 56
$gp.AddArc(0, 0, $r, $r, 180, 90)
$gp.AddArc(200, 0, $r, $r, 270, 90)
$gp.AddArc(200, 200, $r, $r, 0, 90)
$gp.AddArc(0, 200, $r, $r, 90, 90)
$gp.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 17, 24, 39))
$g.FillPath($brush, $gp)
$inset = 30
$g.DrawImage($mark, $inset, $inset, 256 - 2 * $inset, 256 - 2 * $inset)
$g.Dispose(); $mark.Dispose(); $brush.Dispose(); $gp.Dispose()
$canvas.Save($finalPng, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()

# 7) assemble a multi-size ICO (16/24/32/48/64/128/256, PNG-compressed entries)
$src = [System.Drawing.Bitmap]::FromFile($finalPng)
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = New-Object System.Collections.Generic.List[byte[]]
foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs.Add($ms.ToArray())
    $ms.Dispose(); $bmp.Dispose()
}
$src.Dispose()

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
for ($i = 0; $i -lt $pngs.Count; $i++) {
    $s = $sizes[$i]
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($d in $pngs) { $bw.Write($d) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($ico, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
"ICO written: $ico ($((Get-Item $ico).Length) bytes)"

# 8) apply to shortcuts
if (-not $NoShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($path in @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Startup')) 'DSH Background Server.lnk'))) {
        if (Test-Path $path) {
            $lnk = $shell.CreateShortcut($path)
            $lnk.IconLocation = "$ico,0"
            $lnk.Save()
            "Shortcut icon updated: $path"
        }
    }
    & ie4uinit.exe -show 2>$null | Out-Null
}

# 9) clean up intermediates
Remove-Item $markSvg, $wrapHtml, $rawPng -ErrorAction SilentlyContinue
'Done.'
