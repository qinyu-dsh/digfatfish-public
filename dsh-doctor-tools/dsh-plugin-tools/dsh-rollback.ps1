# dsh-rollback.ps1 - restore a snapshot and bring the server back up safely.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File dsh-rollback.ps1 -Snapshot <name>
#   powershell -NoProfile -ExecutionPolicy Bypass -File dsh-rollback.ps1 -Auto        (last healthy snapshot)
#   powershell -NoProfile -ExecutionPolicy Bypass -File dsh-rollback.ps1 -Snapshot <name> -NoRestart
#
# Flow: backup current (bad) state -> restore snapshot trio -> pnpm install ->
# boot probe (restart-dsh.ps1 -ProbeOnly) -> full safe restart -> HTTP 200 verdict.
param([string]$Snapshot, [switch]$Auto, [switch]$NoRestart, [switch]$Force)

. "$PSScriptRoot\watchdog-common.ps1"

$ErrorActionPreference = 'Continue'
$restartScript = Join-Path $WdScriptRoot 'restart-dsh.ps1'

# 1) pick the snapshot
if (-not $Snapshot) {
    if ($Auto) {
        $state0 = Get-WdState
        $Snapshot = $state0.lastHealthySnapshot
    }
    if (-not $Snapshot) { Write-Output 'ERROR: no snapshot given (-Snapshot <name> or -Auto)'; exit 1 }
}
$snapDir = Join-Path $WdSnapRoot $Snapshot
foreach ($f in $WdTrio) {
    if (-not (Test-Path (Join-Path $snapDir $f))) {
        Write-Output "ERROR: snapshot $Snapshot is incomplete (missing $f)"; exit 1
    }
}
Write-Output "rollback target: $Snapshot"

# 0) version boundary guard: a profile-only rollback is only safe while the core and
#    the session DB schema stay on the same major line. Since the 0.1.5 / family 0.3.23
#    upgrade the DB is user_version 3, so restoring a 0.1.1-era profile would boot the
#    old plugin tree on a v3 database - refuse unless -Force is given.
$manPath = Join-Path $snapDir 'manifest.json'
if (Test-Path $manPath) {
    try { $man = Get-Content $manPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $man = $null }
    if ($man -and $man.coreVersion) {
        $curCore = Get-CoreVersion
        $curDb = Get-DbUserVersion
        if ($man.coreVersion -ne $curCore -or ([int]$man.dbUserVersion -ne [int]$curDb)) {
            Write-Output "REFUSED: snapshot was taken under core $($man.coreVersion) / db v$($man.dbUserVersion), now core $curCore / db v$curDb"
            Write-Output 'A profile-only rollback across that boundary would boot an incompatible plugin tree on a migrated database.'
            Write-Output 'Use -Force only if you also restored the core and the session DB yourself.'
            if (-not $Force) { exit 1 }
            Write-Output 'WARN: -Force given, continuing anyway.'
        }
    }
}

# 2) preserve the current (presumably broken) state for later inspection
$crashDir = Join-Path $WdSnapRoot ('crash-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $crashDir | Out-Null
foreach ($f in $WdTrio) {
    $src = Join-Path $WdProfileDir $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $crashDir $f) }
}
Write-Output "broken state preserved at: $crashDir"

# 3) restore the snapshot trio
foreach ($f in $WdTrio) {
    Copy-Item (Join-Path $snapDir $f) (Join-Path $WdProfileDir $f) -Force
}
Write-Output 'profile trio restored'

# 4) sync dependencies
Push-Location D:\dhs01
& dsh plugin --profile web install 2>&1 | Select-Object -Last 3
Pop-Location

# 5) boot probe - never restart onto a snapshot that cannot boot
Write-Output '--- boot probe ---'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restartScript -ProbeOnly 2>&1 | ForEach-Object { Write-Output $_ }
if ($LASTEXITCODE -ne 0) {
    Write-WdEvent 'ERROR' "ROLLBACK FAILED: snapshot $Snapshot failed the boot probe - restoring broken state (server untouched)"
    foreach ($f in $WdTrio) {
        $src = Join-Path $crashDir $f
        if (Test-Path $src) { Copy-Item $src (Join-Path $WdProfileDir $f) -Force }
    }
    $st = Get-WdState
    $st.state = 'error'
    Set-WdState $st
    exit 2
}
Write-Output 'probe PASS'

if ($NoRestart) {
    Write-WdEvent 'INFO' "rollback staged (no restart): $Snapshot"
    Write-Output 'staged - restart manually (restart-dsh.ps1 or desktop icon)'
    exit 0
}

# 6) full safe restart
Write-Output '--- safe restart ---'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restartScript 2>&1 | ForEach-Object { Write-Output $_ }

# 7) verdict: real HTTP 200 on a NEW pid
$ok = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    $conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        try {
            $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { $ok = $true; break }
        } catch { }
    }
}
$pidNow = Get-ServerPid

if ($ok -and $pidNow -gt 0) {
    $state = Get-WdState
    $state.profileHash = (Get-ProfileHash)
    $state.lastHealthySnapshot = $Snapshot
    $state.pendingSnapshot = ''
    $state.state = 'healthy'
    $state.consecutiveFailures = 0
    $state.lastServerPid = $pidNow
    $state.lastLogSize = (Get-LogSize)
    Set-WdState $state
    Write-WdEvent 'INFO' "ROLLBACK OK: restored snapshot $Snapshot, server pid=$pidNow"
    Write-Output "ROLLBACK OK: server pid=$pidNow"
    exit 0
} else {
    Write-WdEvent 'ERROR' "ROLLBACK PARTIAL: snapshot $Snapshot restored but server did not come up (pid=$pidNow) - inspect dsh-server.log"
    Write-Output 'ROLLBACK PARTIAL: server did not come up - inspect dsh-server.log'
    $st = Get-WdState
    $st.state = 'error'
    Set-WdState $st
    exit 3
}
