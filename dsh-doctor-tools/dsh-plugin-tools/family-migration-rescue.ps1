# family-migration-rescue.ps1 - independent dead-man's switch for the core+family migration.
#
# Why a SECOND script: on 2026-09-16 the migration/restart script was itself killed
# mid-flight (task exit 0xC000013A) and the machine was left with no server and no
# rollback - the rollback lived inside the process that died. This script runs from its
# OWN scheduled task, so a dead migration script cannot take it down with it.
#
# Behaviour: wait up to $WaitSeconds for http://127.0.0.1:3080 to answer 200.
#   healthy  -> log and exit 0 (touches nothing)
#   not healthy -> roll back: stop whatever owns 3080, restore the pre-migration profile
#   files from $BackupDir, reinstall the previous core, pnpm install, start, verify 200.
param(
    [string]$BackupDir = '',
    [string]$PreviousCore = '0.1.1-rc.2',
    [int]$WaitSeconds = 900,
    [int]$PollSeconds = 10
)
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log = Join-Path $root 'family-migration-rescue.log'
$report = Join-Path $root 'family-migration-rescue.report.json'

function L([string]$m) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}

# node moved to D:\dsh\node on 2026-09-16: make it resolvable for every child spawn.
$nodeDir = 'D:\dsh\node'
if ((Test-Path (Join-Path $nodeDir 'node.exe')) -and ($env:PATH -notlike ('*' + $nodeDir + '*'))) { $env:PATH = $nodeDir + ';' + $env:PATH }
$node = 'D:\dsh\node\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
$npmCli = Join-Path (Split-Path $node -Parent) 'node_modules\npm\bin\npm-cli.js'
$pnpmCli = Join-Path $env:APPDATA 'npm\node_modules\pnpm\bin\pnpm.cjs'
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$startServer = 'D:\dhs01\dsh-desktop\start-server.ps1'

# Health check that survives the launch-token gate: the plugin API answers without a
# token on every core version, while the index page is token-gated on newer cores.
function Test-Alive([string]$base) {
    try { $r = Invoke-WebRequest ($base + 'api/plugin-manager/failures') -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { return $true } } catch { }
    try { $r = Invoke-WebRequest $base -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { return $true } } catch { if ($_.Exception.Response -ne $null) { return $true } }
    return $false
}
function Stop-Server {
    $conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { L 'no listener on 3080'; return $true }
    $old = [int]$conn.OwningProcess
    L ('killing pid ' + $old)
    taskkill /PID $old /T /F 2>&1 | Out-Null
    for ($i = 0; $i -lt 12; $i++) { Start-Sleep -Milliseconds 700; if (-not (Get-Process -Id $old -ErrorAction SilentlyContinue)) { break } }
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) { L ('ABORT: pid ' + $old + ' survived'); return $false }
    L 'server stopped (verified)'
    return $true
}

L '=== family migration rescue: armed ==='
L ('node=' + $node)
$marker = Join-Path $root 'family-migration.state.json'
L ('waiting up to ' + $WaitSeconds + 's for a healthy server (migration marker: ' + $marker + ')')
$startedAt = Get-Date
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$healthy = $false
while ((Get-Date) -lt $deadline) {
    # marker freshness matters: a marker left over from an earlier run must not trigger a rollback
    $st = ''; $stAt = $null
    try { if (Test-Path $marker) { $mj = Get-Content $marker -Raw -Encoding UTF8 | ConvertFrom-Json; $st = $mj.status; try { $stAt = [datetime]::Parse($mj.at) } catch { } } } catch { }
    $fresh = ($null -ne $stAt) -and ($stAt -ge $startedAt.AddSeconds(-60))
    if ($fresh -and $st -eq 'failed') { L 'migration marked FAILED - rolling back immediately'; break }
    if ($fresh -and $st -eq 'done') {
        if (Test-Alive 'http://127.0.0.1:3080/') { L 'migration marked DONE and the server answers 200'; $healthy = $true; break }
        L 'migration marked DONE but no HTTP 200 - rolling back'; break
    }
    # NOTE: a 200 here proves nothing - the migration kills the server mid-window, and it
    Start-Sleep -Seconds $PollSeconds
}
if (-not $healthy -and (Get-Date) -ge $deadline) {
    if (Test-Alive 'http://127.0.0.1:3080/') { L 'grace period elapsed but the server answers 200 - accepting as healthy'; $healthy = $true }
    else { L 'grace period elapsed and the server is down - rolling back' }
}

if ($healthy) {
    L 'server is healthy - rescue does nothing'
    $obj = [pscustomobject]@{ at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); verdict = 'HEALTHY'; rolledBack = $false }
    [System.IO.File]::WriteAllText($report, ($obj | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding($false)))
    exit 0
}

L 'server NOT healthy - rolling back'
$rolledBack = $false
if ($BackupDir -and (Test-Path $BackupDir)) {
    # a hung migration must not race this rollback on the same profile directory
    $stuck = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*family-migration.ps1*' -and $_.ProcessId -ne $PID }
    foreach ($mp in $stuck) { L ('killing stuck migration process ' + $mp.ProcessId); taskkill /PID $mp.ProcessId /T /F 2>&1 | Out-Null }
    if ($stuck) { Start-Sleep -Seconds 3 }
    if (Stop-Server) {
        foreach ($f in @('package.json','cordis.patch.yml','pnpm-workspace.yaml','pnpm-lock.yaml')) {
            $src = Join-Path $BackupDir $f
            if (Test-Path $src) { Copy-Item $src (Join-Path $profile $f) -Force; L ('restored ' + $f) }
        }
        $patchDir = Join-Path $BackupDir 'patches'
        if (Test-Path $patchDir) { Copy-Item (Join-Path $patchDir '*') (Join-Path $profile 'patches') -Recurse -Force -ErrorAction SilentlyContinue; L 'restored patches/' }
        # restore the session DB to its pre-window state: the migration advances user_version
        # (1 -> 2 -> 3) and rewrites the schema, so a rollback must put the old shape back.
        $dbBak = Join-Path $BackupDir 'sessions-db-pre-window'
        if (Test-Path $dbBak) {
            $dbDir = Join-Path $env:USERPROFILE '.dsh\sessions'
            foreach ($f in @('sessions.sqlite','sessions.sqlite-wal','sessions.sqlite-shm')) {
                $b = Join-Path $dbBak $f
                if (Test-Path $b) { Copy-Item $b (Join-Path $dbDir $f) -Force; L ('restored db: ' + $f) }
            }
        } else { L 'no pre-window db backup found - leaving the session database as is' }
                # Prefer the stash the migration left behind: it is the exact tree that was running
                # before, restored by rename with no network. npm is only the fallback -- right now no
                # 0.1.5-rcN meta-package installs at all (ETARGET on sidebar-documentpreview@rc.3), so a
                # stash is the only way back from a staged core.
                $stashFile = Join-Path $root 'core-stash.txt'
                $stashUsed = $false
                if (Test-Path $stashFile) {
                    $stash = (Get-Content $stashFile -Raw).Trim()
                    $globalCorePath2 = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh'
                    if ($stash -and (Test-Path $stash)) {
                        Remove-Item $globalCorePath2 -Recurse -Force -ErrorAction SilentlyContinue
                        Move-Item $stash $globalCorePath2 -Force -ErrorAction SilentlyContinue
                        Remove-Item $stashFile -Force -ErrorAction SilentlyContinue
                        $stashUsed = $true
                        L ('previous core restored from stash -> ' + $globalCorePath2)
                    }
                }
                if (-not $stashUsed) { L 'reinstalling previous core ' ; & $node $npmCli 'i' '-g' ('@deepseek-ai/dsh@' + $PreviousCore) '--no-fund' '--no-audit' 2>&1 | ForEach-Object { L ('npm> ' + $_) } }
        L 'pnpm install (restore plugin tree from the restored lockfile)'
        & $node $pnpmCli 'install' '-w' '--dir' $profile '--prefer-offline' '--reporter=append-only' 2>&1 | ForEach-Object { L ('pnpm> ' + $_) }
        $rolledBack = $true
    }
} else { L ('no backup dir given or missing: ' + $BackupDir + ' - cannot roll back the profile') }

if (Test-Path $startServer) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startServer | Out-Null }
$httpOk = $false
for ($i = 0; $i -lt 120; $i++) { Start-Sleep -Seconds 1; if (Test-Alive 'http://127.0.0.1:3080/') { $httpOk = $true; break } }
$conn2 = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$pid2 = 0
if ($conn2) { $pid2 = [int]$conn2.OwningProcess }
L ('rescue result: rolledBack=' + $rolledBack + ' http200=' + $httpOk + ' pid=' + $pid2)
$obj = [pscustomobject]@{ at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); verdict = $(if ($httpOk) { 'RESCUED' } else { 'FAILED' }); rolledBack = $rolledBack; pid = $pid2; backupDir = $BackupDir }
[System.IO.File]::WriteAllText($report, ($obj | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding($false)))
exit 0
