# Start the DeepSeek Harness web server in a hidden background window if it is
# not already listening. Exit code 0 = server is up; 1 = failed in time.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File start-server.ps1
#
# 2026-09-16 hardening: node.exe was moved to D:\dsh\node\ and the machine PATH
# entry D:\dsh\ no longer resolves "node", so the npm launcher shim (dsh.ps1:24
# -> bare "node") died with CommandNotFound and NO server could be started at all
# (23-minute outage after the doctor purge). Resolve node.exe and the dsh entry
# script explicitly; keep the shim / npx path only as a last resort.
param(
    [int]$Port = 3080,
    [int]$TimeoutSeconds = 90
)
$ErrorActionPreference = 'SilentlyContinue'

function Test-PortListening([int]$p) {
    return $null -ne (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Resolve-NodeExe {
    foreach ($c in @('D:\dsh\node\node.exe', 'D:\dsh\node.exe')) { if (Test-Path $c) { return $c } }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    $hit = Get-ChildItem 'D:\dsh' -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
    return $null
}

# The dsh entry script that the npm shim itself would run ($basedir/node_modules/...).
function Resolve-DshBin {
    $cands = @()
    $shim = Get-Command dsh -ErrorAction SilentlyContinue
    if ($shim -and $shim.Source) { $cands += (Join-Path (Split-Path $shim.Source -Parent) 'node_modules\@deepseek-ai\dsh\lib\bin.js') }
    if ($env:APPDATA) { $cands += (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js') }
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}

if (Test-PortListening $Port) { exit 0 }

$logFile = Join-Path $PSScriptRoot 'dsh-server.log'

# 2026-09-22: prefer PowerShell 7 when present. pwsh writes UTF-8 by default, which keeps
# dsh-server.log readable (5.1 wrote UTF-16 / ANSI, and that mixed encoding cost us a whole
# failed migration round when the launch token could not be scraped back out of the log).
function Resolve-ShellExe {
    $c = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
    if (Test-Path $c) { return $c }
    $cmd = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    return 'powershell.exe'
}

$node = Resolve-NodeExe
$bin = Resolve-DshBin
if ($node -and $bin) {
    $serverCmd = "& '" + $node + "' '" + $bin + "' web --no-open"
    $how = 'node+bin'
} else {
    # Last resort: the npm shim (needs node on PATH) or a one-shot npx download.
    $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($dshCmd) { $serverCmd = 'dsh web --no-open'; $how = 'shim(PATH)' }
    else { $serverCmd = 'npx --yes @deepseek-ai/dsh web --no-open'; $how = 'npx' }
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$shell = Resolve-ShellExe
Add-Content -Path $logFile -Value ('[' + $stamp + '] start-server: how=' + $how + ' shell=' + (Split-Path $shell -Leaf) + ' node=' + $node + ' bin=' + $bin) -Encoding utf8

$bootstrap = "`$ErrorActionPreference='Continue'; " + $serverCmd + " *>> '" + $logFile + "'"
Start-Process -FilePath $shell `
    -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $bootstrap `
    -WindowStyle Hidden -WorkingDirectory $PSScriptRoot | Out-Null

for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
    Start-Sleep -Seconds 1
    if (Test-PortListening $Port) { exit 0 }
}
exit 1
