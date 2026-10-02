# watchdog-dsh.ps1 - one pass of the DSH self-healing watchdog.
# Scheduled every 2 minutes (see install-watchdog.ps1). It:
#   1. detects profile changes (package.json / cordis.patch.yml / pnpm-workspace.yaml)
#      and snapshots them BEFORE they can crash the running server;
#   2. verifies a changed config is actually healthy after a restart and only then
#      marks the new snapshot as the rollback baseline;
#   3. when the server is down/unhealthy (or the log shows crash markers) twice in a
#      row, rolls back to the last healthy snapshot automatically.
# State lives in watchdog-state.json; every action is appended to watchdog.log.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File watchdog-dsh.ps1

. "$PSScriptRoot\watchdog-common.ps1"

$state = Get-WdState
$hash = Get-ProfileHash
$healthy = Test-ServerHealthy
$pidNow = Get-ServerPid
$logCrash = Test-LogCrash ([long]$state.lastLogSize)
$logSize = Get-LogSize

# --- 0) first run: establish a baseline snapshot so rollback always has an anchor
if ($state.profileHash -eq '') {
    if ($healthy) {
        $name = 'baseline-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dsh-snapshot.ps1') -Take -Name $name 2>&1 | Out-Null
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dsh-snapshot.ps1') -MarkHealthy -Name $name 2>&1 | Out-Null
        $state = Get-WdState   # re-read (MarkHealthy rewrote the file)
        $state.profileHash = $hash
        $state.lastServerPid = $pidNow
        $state.lastLogSize = $logSize
        Set-WdState $state
        Write-WdEvent 'INFO' "watchdog initialized: baseline snapshot $name marked healthy (server pid=$pidNow)"
        exit 0
    }
    Write-WdEvent 'WARN' 'watchdog init: server NOT healthy - no baseline taken yet'
    exit 0
}

# --- 1) profile change detection -> snapshot before it can bite
if ($hash -ne $state.profileHash) {
    $name = 'auto-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dsh-snapshot.ps1') -Take -Name $name 2>&1 | Out-Null
    $state.profileHash = $hash
    $state.pendingSnapshot = $name
    $state.state = 'pending'
    Write-WdEvent 'INFO' "profile change detected -> snapshot $name (pending verification)"
}

# --- 2) health verdict
if ($healthy) {
    $restarted = ($pidNow -gt 0 -and ($state.lastServerPid -eq 0 -or $pidNow -ne $state.lastServerPid))
    if ($state.state -eq 'pending' -and $restarted) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dsh-snapshot.ps1') -MarkHealthy -Name $state.pendingSnapshot 2>&1 | Out-Null
        Write-WdEvent 'INFO' "config verified on restart (pid=$pidNow) -> snapshot $($state.pendingSnapshot) marked healthy"
        $state = Get-WdState
    } elseif ($state.state -eq 'pending') {
        Write-WdEvent 'INFO' "config change pending - server healthy but not restarted yet (pid=$pidNow)"
    }
    if ($logCrash) {
        Write-WdEvent 'WARN' "crash markers found in dsh-server.log but HTTP is 200 (server pid=$pidNow)"
    }
    $state.consecutiveFailures = 0
    $state.lastServerPid = $pidNow
    $state.lastLogSize = $logSize
    Set-WdState $state
    exit 0
}

# --- 3) unhealthy path
$state.consecutiveFailures = [int]$state.consecutiveFailures + 1
$state.lastLogSize = $logSize
$state.lastServerPid = 0
$reason = if ($logCrash) { 'crash markers in log' } else { 'no HTTP 200' }
Write-WdEvent 'WARN' "server unhealthy ($reason) - failure $($state.consecutiveFailures)/2 (pid=$pidNow)"

$suppress = ($state.state -eq 'error' -and $state.lastCheck -ne '')
$suppressAge = 0
if ($suppress) {
    try { $suppressAge = [int]((Get-Date) - ([datetime]$state.lastCheck)).TotalMinutes } catch { $suppressAge = 0 }
    if ($suppressAge -ge 10) { $suppress = $false }
}

if ($state.consecutiveFailures -ge 2 -and $state.lastHealthySnapshot -and -not $suppress) {
    Write-WdEvent 'WARN' "TRIGGERING rollback to snapshot $($state.lastHealthySnapshot)"
    $state.state = 'rollback'
    Set-WdState $state
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'dsh-rollback.ps1') -Snapshot $state.lastHealthySnapshot 2>&1 | ForEach-Object { Write-Output $_ }
    exit 0
}

if ($state.consecutiveFailures -ge 2 -and -not $state.lastHealthySnapshot) {
    Write-WdEvent 'ERROR' 'unhealthy but NO healthy snapshot exists - manual intervention required'
}

Set-WdState $state
exit 1
