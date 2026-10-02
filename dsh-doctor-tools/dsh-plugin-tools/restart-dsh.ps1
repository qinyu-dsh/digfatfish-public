# restart-dsh.ps1 - SAFE restart of the dsh web server on port 3080.
#
# Safety-first design (hardened after the 2026-08-17 session-title incident,
# where a broken patch made every fresh start crash):
#   1. BOOT PROBE FIRST: boots a real second instance on a spare port. If the
#      current patch cannot boot, the script ABORTS - it never kills a healthy
#      running server to replace it with one that would crash.
#   2. Only after a PASSING probe does it kill the 3080 listener, start a
#      fresh server, and verify real readiness (port + HTTP 200).
#   3. dump-config is informational only (composition != config validity).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File restart-dsh.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File restart-dsh.ps1 -ProbeOnly
#   powershell -NoProfile -ExecutionPolicy Bypass -File restart-dsh.ps1 -Profile web
param([switch]$ProbeOnly, [string]$Profile = 'web')
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'restart-check.log'
$serverLog = 'D:\dhs01\dsh-desktop\dsh-server.log'

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $log -Value $line -Encoding UTF8
    Write-Output $line
}

function Remove-RestartTasks {
    # delete any one-shot scheduled task that launched this script (the task
    # name may vary, e.g. "DSH Restart Check" or "DSHRestart<time>")
    schtasks /Query /FO CSV 2>$null | Select-String 'DSH.?Restart' | ForEach-Object {
        $n = ($_.Line -split ',')[0].Trim('"')
        schtasks /Delete /TN $n /F 2>$null | Out-Null
    }
}

function Invoke-BootProbe([int]$TimeoutSeconds = 60) {
    # Boot a real second dsh web instance on an OS-assigned port and verify it
    # serves HTTP. The only check that proves the current patch actually boots.
    $logFile = Join-Path $PSScriptRoot 'probe.log'
    Remove-Item $logFile -ErrorAction SilentlyContinue
    $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
    $cmd = if ($dshCmd) { "dsh --profile $Profile --no-open --port 0" } else { "npx --yes @deepseek-ai/dsh --profile $Profile --no-open --port 0" }
    $bootstrap = "`$ErrorActionPreference='Continue'; " + $cmd + " *>> '" + $logFile + "'"
    $p = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $bootstrap `
        -PassThru -WindowStyle Hidden
    $url = $null
    for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Path $logFile) {
            $m = Select-String -Path $logFile -Pattern 'http://127\.0\.0\.1:\d+' | Select-Object -First 1
            if ($m) { $url = $m.Matches[0].Value; break }
        }
        if ($p.HasExited) { break }
    }
    $ok = $false
    if ($url) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
            $ok = ($r.StatusCode -eq 200)
        } catch { $ok = $false }
    }
    if (-not $p.HasExited) { taskkill /PID $p.Id /T /F | Out-Null }
    Remove-Item $logFile -ErrorAction SilentlyContinue
    return $ok
}

Write-Log "=== restart start (profile=$Profile) ==="

# 0) boot probe FIRST - never kill a healthy server for a patch that cannot boot
$probeOk = Invoke-BootProbe
if (-not $probeOk) {
    Write-Log 'ABORT: boot probe FAILED with the current patch - refusing to kill the running server.'
    Write-Log 'Fix the patch first (see D:\dhs01\dsh-sample-plugin\README.md), then re-run.'
    Write-Log 'verdict: ABORTED (probe failed, running server untouched)'
    Write-Log '=== restart done ==='
    Remove-RestartTasks
    exit 1
}
Write-Log 'boot probe PASS - the current patch boots on a spare port'

if ($ProbeOnly) {
    Write-Log 'ProbeOnly mode - no restart performed'
    Write-Log 'verdict: PROBE PASS (running server untouched)'
    Write-Log '=== restart done ==='
    schtasks /Delete /TN 'DSH Restart Check' /F 2>$null | Out-Null
    exit 0
}

# 1) kill whatever listens on 3080 - and VERIFY it actually died (2026-08-17
#    lesson: a silent taskkill failure left the old server running and the
#    script reported a false PASS)
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
    $pid3080 = $conn.OwningProcess
    taskkill /PID $pid3080 /T /F 2>&1 | Out-Null
    $killExit = $LASTEXITCODE
    Start-Sleep -Seconds 2
    $stillAlive = [bool](Get-Process -Id $pid3080 -ErrorAction SilentlyContinue)
    if ($stillAlive) {
        # one more attempt through PowerShell's own termination path
        try { Stop-Process -Id $pid3080 -Force -ErrorAction Stop; Start-Sleep -Seconds 2 } catch { }
        $stillAlive = [bool](Get-Process -Id $pid3080 -ErrorAction SilentlyContinue)
    }
    if ($stillAlive) {
        Write-Log "ABORT: old server pid=$pid3080 could not be killed (taskkill exit=$killExit) - likely blocked by security software (e.g. Huorong/360). Nothing was changed; the running server is untouched."
        Write-Log 'Fix: kill node.exe manually in Task Manager, or allow dsh in your antivirus, then re-run this script.'
        Write-Log 'verdict: ABORTED (old server still alive)'
        Write-Log '=== restart done ==='
        schtasks /Delete /TN 'DSH Restart Check' /F 2>$null | Out-Null
        exit 1
    }
    Write-Log "killed old server pid=$pid3080 (verified gone)"
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)) { break }
    }
} else {
    Write-Log 'no server was listening on 3080'
}

# 2) start a fresh hidden server (same logic as the desktop launcher)
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
$serverCmd = if ($dshCmd) { 'dsh web --no-open' } else { 'npx --yes @deepseek-ai/dsh web --no-open' }
$bootstrap = "`$ErrorActionPreference='Continue'; " + $serverCmd + " *>> '" + $serverLog + "'"
Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $bootstrap `
    -WindowStyle Hidden -WorkingDirectory $PSScriptRoot | Out-Null
Write-Log "started new server: $serverCmd"

# 3) wait for real readiness (port listening + HTTP 200)
$httpOk = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    $c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
        try {
            $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { $httpOk = $true; break }
        } catch { }
    }
}
$conn2 = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$newPid = if ($conn2) { $conn2.OwningProcess } else { $null }
# guard: if the old pid is still the one answering, the restart did not happen
if ($httpOk -and $newPid -eq $pid3080) {
    Write-Log "ERROR: listener pid=$newPid is still the OLD server - restart did not take effect"
    $httpOk = $false
}
Write-Log "server ready: http200=$httpOk  pid=$newPid  waited=$i s"

# 4) composition check (informational only)
$out = dsh --profile $Profile --dump-config 2>&1
$code = $LASTEXITCODE
$hasSample = ($out | Select-String -Pattern 'dsh-sample-plugin' -Quiet)
Write-Log "dump-config exit=$code  sample-plugin-layer=$hasSample (informational - composition only)"

# 5) data integrity
$sessions = (Get-ChildItem (Join-Path $env:USERPROFILE '.dsh\sessions') -Recurse -Filter '*.zstd' -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Log "session-files=$sessions"

# 6) server log tail (first errors, if any)
$tail = @(Get-Content $serverLog -Tail 5 -ErrorAction SilentlyContinue)
Write-Log "server-log-tail: $($tail -join ' | ')"

# 7) verdict - judged by the REAL start, not by dump-config
$verdict = if ($httpOk) { 'PASS' } else { 'FAIL - new server did not come up; check dsh-server.log and the patch (see D:\dhs01\dsh-sample-plugin\README.md)' }
Write-Log "verdict: $verdict"
Write-Log '=== restart done ==='

# self-cleanup: remove the one-shot scheduled task that launched this script
Remove-RestartTasks
