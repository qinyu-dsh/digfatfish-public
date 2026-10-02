# restart-dsh-taskboard.ps1
# Task-board-aware restart for the web-ui 0.2.5 era.
#
# Why not the plain restart-dsh.ps1: the task-board plugin (0.2.5) holds a
# single-instance ledger lock (~/.dsh/task-board/ledger-v2.lock) owned by the
# RUNNING server pid. A boot probe that starts a SECOND instance while the
# old server is alive is therefore rejected ("ledger is already owned by
# process <pid>") - a false negative, not a broken patch.
#
# This variant changes the ORDER: kill the old server FIRST (releases the
# lock), THEN boot-probe the current patch on a spare port. If the probe
# passes, start the fresh server. If the probe fails, roll back to the
# snapshot named by -RollbackSnapshot and start over, so a truly broken
# patch never leaves this machine without a running dsh.
#
# Usage (scheduled task only - never run synchronously from an agent
# session, the kill step would kill your own process tree):
#   powershell -NoProfile -ExecutionPolicy Bypass -File restart-dsh-taskboard.ps1 -RollbackSnapshot before-dshmeme-20260820
param([string]$Profile = 'web', [string]$RollbackSnapshot = '')
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'restart-taskboard.log'
$serverLog = 'D:\dhs01\dsh-desktop\dsh-server.log'
$tools = $PSScriptRoot

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $log -Value $line -Encoding UTF8
    Write-Output $line
}

function Remove-TaskBoards {
    schtasks /Query /FO CSV 2>$null | Select-String 'DSH.?Restart|DSHTaskboard|DSHProbe' | ForEach-Object {
        $n = ($_.Line -split ',')[0].Trim('"')
        schtasks /Delete /TN $n /F 2>$null | Out-Null
    }
}

function Invoke-BootProbe([int]$TimeoutSeconds = 60) {
    # Boot a real second dsh web instance on an OS-assigned port and verify it
    # serves HTTP. Callers must ensure the 3080 listener (and thus the
    # task-board ledger lock) is DEAD before invoking.
    $logFile = Join-Path $tools 'probe.log'
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
    # 2026-08-25 fix: the probe boot writes its own task-board ledger lock; a
    # hard taskkill can leave it corrupt/unreadable, and the NEXT real server
    # then dies with "task-board ledger lock is unreadable" (0.3.4 upgrade
    # restart outage). Clean the probe lock here, only when it is owned by a
    # dead pid (or unreadable) - never a live owner.
    $probeLock = Join-Path $env:USERPROFILE '.dsh\task-board\ledger-v2.lock'
    if (Test-Path $probeLock) {
        try {
            $probeOwner = Get-Content $probeLock -Raw -Encoding UTF8 | ConvertFrom-Json
            $probeAlive = $null -ne (Get-Process -Id $probeOwner.pid -ErrorAction SilentlyContinue)
            if ($probeOwner.pid -eq $p.Id -or -not $probeAlive) {
                Remove-Item $probeLock -Force
                Write-Log "removed probe task-board lock (owner pid $($probeOwner.pid) dead/probe)"
            } else {
                Write-Log "probe task-board lock owned by live pid $($probeOwner.pid) - leaving it"
            }
        } catch {
            Remove-Item $probeLock -Force -ErrorAction SilentlyContinue
            Write-Log 'removed unreadable probe task-board lock file'
        }
    }
    if (Test-Path $logFile) {
        $fail = Get-Content $logFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        if ($fail -match 'ledger is already owned|already owned by process') {
            # a lock conflict during the probe means the task-board plugin
            # loaded and was rejected by single-instance protection - treat as
            # an environmental false negative ONLY if the probe instance itself
            # was killed by us; otherwise it is a real failure
            if (-not $ok) { Write-Log 'probe note: task-board lock conflict seen during probe' }
        }
        Remove-Item $logFile -ErrorAction SilentlyContinue
    }
    return $ok
}

Write-Log '=== restart-taskboard start ==='

# 0) verify the old server is really listening (we are about to kill it)
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) {
    Write-Log 'no listener on 3080 - nothing to kill; continuing to probe + start'
}

# 1) kill whatever listens on 3080 - and VERIFY it actually died
if ($conn) {
    $old = $conn.OwningProcess
    taskkill /PID $old /T /F 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) {
        Stop-Process -Id $old -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) {
        Write-Log "ABORT: old server pid=$old could not be killed (security software?) - nothing changed"
        exit 1
    }
    Write-Log "killed old server pid=$old (verified gone)"
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue)) { break }
    }
}

# 1.5) task-board lock should now be stale; clear it if it still names a live
# pid that is NOT ours (safety for partially-released locks)
$lockFile = Join-Path $env:USERPROFILE '.dsh\task-board\ledger-v2.lock'
if (Test-Path $lockFile) {
    try {
        $owner = Get-Content $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue)) {
            Remove-Item $lockFile -Force
            Write-Log "removed stale task-board lock (owner pid $($owner.pid) dead)"
        } else {
            Write-Log "task-board lock still owned by live pid $($owner.pid) - leaving it"
        }
    } catch {
        Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
        Write-Log 'removed unreadable task-board lock file'
    }
}

# 2.5) Rebuild session projection cache while the server is down (cache is rebuildable; seq domain normalized to RDB head)
$projCache = Join-Path $env:USERPROFILE '.dsh\storages\session_projcache.json'
if (Test-Path $projCache) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bak = Join-Path $env:USERPROFILE ".dsh\storages\session_projcache.json.bak-projfix-$stamp"
    Copy-Item $projCache $bak -Force
    Write-Log "proj cache backup: $bak"
}
Write-Log 'running proj cache normalization...'
& 'C:\Windows\System32\cmd.exe' /c "D:\dsh\node.exe D:\dhs01\dsh-plugin-tools\fix-projcache.cjs > D:\dhs01\dsh-profile-backup\fix-projcache.log 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Log "ABORT: proj cache normalization failed (exit $LASTEXITCODE) - see D:\dhs01\dsh-profile-backup\fix-projcache.log"
    exit 1
}
Write-Log 'proj cache normalized'

# 2) boot probe NOW that the lock is free - the true test of the patch
$probeOk = Invoke-BootProbe
if (-not $probeOk) {
    Write-Log 'ABORT: boot probe FAILED after killing old server - patch is genuinely broken'
    if ($RollbackSnapshot) {
        Write-Log "rolling back to snapshot: $RollbackSnapshot"
        powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tools 'dsh-rollback.ps1') -Snapshot $RollbackSnapshot -NoRestart 2>&1 | ForEach-Object { Write-Log "rollback: $_" }
        Write-Log 'rollback restore done - starting server from restored state'
        # start the server again from the rolled-back state
        $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
        $serverCmd = if ($dshCmd) { 'dsh web --no-open' } else { 'npx --yes @deepseek-ai/dsh web --no-open' }
        $bootstrap = "`$ErrorActionPreference='Continue'; " + $serverCmd + " *>> '" + $serverLog + "'"
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $bootstrap `
            -WindowStyle Hidden -WorkingDirectory $tools | Out-Null
        Write-Log 'server started from rolled-back state'
    } else {
        Write-Log 'no rollback snapshot specified - starting server anyway (may fail)'
        $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
        $serverCmd = if ($dshCmd) { 'dsh web --no-open' } else { 'npx --yes @deepseek-ai/dsh web --no-open' }
        $bootstrap = "`$ErrorActionPreference='Continue'; " + $serverCmd + " *>> '" + $serverLog + "'"
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $bootstrap `
            -WindowStyle Hidden -WorkingDirectory $tools | Out-Null
        Write-Log 'server started (unverified patch)'
    }
} else {
    Write-Log 'boot probe PASS (lock-free) - starting fresh server'
    $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
    $serverCmd = if ($dshCmd) { 'dsh web --no-open' } else { 'npx --yes @deepseek-ai/dsh web --no-open' }
    $bootstrap = "`$ErrorActionPreference='Continue'; " + $serverCmd + " *>> '" + $serverLog + "'"
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $bootstrap `
        -WindowStyle Hidden -WorkingDirectory $tools | Out-Null
    Write-Log "started new server: $serverCmd"
}

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
Write-Log "server ready: http200=$httpOk  pid=$newPid  waited=$i s"

# 4) verdict
$verdict = if ($httpOk) { 'PASS' } else { 'FAIL - new server did not come up; check dsh-server.log' }
Write-Log "verdict: $verdict"
Write-Log '=== restart-taskboard done ==='

Remove-TaskBoards
