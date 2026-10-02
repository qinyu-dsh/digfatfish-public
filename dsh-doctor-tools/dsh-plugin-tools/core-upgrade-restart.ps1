# core-upgrade-restart.ps1 - SCHEDULED TASK ONLY.
#
# Why this exists: the DSH core was upgraded with npm i -g @deepseek-ai/dsh@0.1.5-rc.1
# while the old server kept running. Applying it needs a restart, and the agent turn
# that arranged the upgrade lives INSIDE the server being restarted - so if the new
# core cannot boot, nobody is left to fix it interactively.
#
# Flow: delay -> PATH bootstrap -> kill the 3080 owner (verified dead) -> clear a stale
# task-board ledger lock -> boot probe on an OS-assigned port -> on FAIL reinstall
# $FallbackVersion and probe again -> start the server through the hardened
# start-server.ps1 -> wait for HTTP 200 -> write a JSON report + verdict.
#
# 2026-09-16 context: node.exe was moved to D:\dsh\node\ and PATH no longer resolves
# node, which broke every launcher that went through the npm dsh shim. This script
# prepends that directory before spawning anything and resolves node/bin.js explicitly.
param(
    [string]$ProfileName = 'web',
    [string]$FallbackVersion = '0.1.1-rc.2',
    [int]$DelaySeconds = 120,
    [int]$ProbeTimeoutSeconds = 75,
    [int]$ReadyTimeoutSeconds = 120,
    [int]$WaitPid = 0,
    [int]$WaitPidTimeoutSeconds = 1800
)
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log = Join-Path $root 'core-upgrade-restart.log'
$report = Join-Path $root 'core-upgrade-restart.report.json'

function L([string]$m) {
    $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}

# node moved to D:\dsh\node on 2026-09-16: make it resolvable for every child spawn.
$nodeDir = 'D:\dsh\node'
if ((Test-Path (Join-Path $nodeDir 'node.exe')) -and ($env:PATH -notlike ('*' + $nodeDir + '*'))) {
    $env:PATH = $nodeDir + ';' + $env:PATH
}

function Resolve-NodeExe {
    foreach ($c in @('D:\dsh\node\node.exe', 'D:\dsh\node.exe')) { if (Test-Path $c) { return $c } }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    return $null
}
function Resolve-DshBin {
    $cands = @()
    $shim = Get-Command dsh -ErrorAction SilentlyContinue
    if ($shim -and $shim.Source) { $cands += (Join-Path (Split-Path $shim.Source -Parent) 'node_modules\@deepseek-ai\dsh\lib\bin.js') }
    if ($env:APPDATA) { $cands += (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js') }
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}
function Clear-DeadProbeLock {
    # A hard-killed probe can leave ~/.dsh/task-board/ledger-v2.lock corrupt, and the
    # next real server then dies with 'ledger lock is unreadable' (2026-08-25 outage).
    # Remove it only when the owner pid is dead or the file is unreadable.
    $lock = Join-Path $env:USERPROFILE '.dsh\task-board\ledger-v2.lock'
    if (-not (Test-Path $lock)) { return }
    try {
        $owner = Get-Content $lock -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -eq $owner.pid) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; L 'cleared lock with no owner pid'; return }
        if ($null -eq (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue)) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; L ('cleared stale task-board lock (owner pid ' + $owner.pid + ' dead)') }
        else { L ('task-board lock owned by live pid ' + $owner.pid + ' - left alone') }
    } catch { Remove-Item $lock -Force -ErrorAction SilentlyContinue; L 'cleared unreadable task-board lock' }
}

function Invoke-BootProbe([int]$TimeoutSeconds) {
    $probeLog = Join-Path $root 'core-upgrade-probe.log'
    Remove-Item $probeLog -Force -ErrorAction SilentlyContinue
    $cmd = "& '" + $script:node + "' '" + $script:bin + "' --profile " + $ProfileName + ' --no-open --port 0'
    $bootstrap = "`$ErrorActionPreference='Continue'; " + $cmd + " *>> '" + $probeLog + "'"
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command',$bootstrap -WindowStyle Hidden -PassThru
    $url = $null
    for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Path $probeLog) {
            $m = Select-String -Path $probeLog -Pattern 'http://127\.0\.0\.1:\d+' | Select-Object -First 1
            if ($m) { $url = $m.Matches[0].Value; break }
        }
        if ($p.HasExited) { break }
    }
    $ok = $false
    if ($url) {
        for ($j = 0; $j -lt 20; $j++) {
            try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { }
            Start-Sleep -Milliseconds 800
        }
    }
    if (-not $p.HasExited) { taskkill /PID $p.Id /T /F 2>&1 | Out-Null }
    Start-Sleep -Seconds 2
    Clear-DeadProbeLock
    if (-not $ok -and (Test-Path $probeLog)) {
        $tail = (Get-Content $probeLog -Tail 6 -ErrorAction SilentlyContinue) -join ' | '
        L ('probe output tail: ' + $tail)
    }
    return $ok
}
function Get-CoreVersion { try { return (& $script:node $script:bin --version 2>&1 | Select-Object -First 1).ToString().Trim() } catch { return 'unknown' } }

L '=== core upgrade restart: scheduled run ==='
L ('delay ' + $DelaySeconds + 's so the arranging agent turn can finish')
Start-Sleep -Seconds $DelaySeconds

# 0) wait for the background npm install to finish - it is rewriting this very tree,
#    and probing mid-install only produces MODULE_NOT_FOUND noise.
if ($WaitPid -gt 0) {
    if (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) {
        L ('waiting for npm pid ' + $WaitPid + ' (timeout ' + $WaitPidTimeoutSeconds + 's)')
        try { Wait-Process -Id $WaitPid -Timeout $WaitPidTimeoutSeconds -ErrorAction Stop; L 'npm process finished' }
        catch { L 'WARN: npm wait timed out - continuing anyway' }
    } else { L ('npm pid ' + $WaitPid + ' already gone') }
    Start-Sleep -Seconds 5
    foreach ($f in @('core-upgrade-npm.out','core-upgrade-npm.err')) {
        $pf = Join-Path $root $f
        if (Test-Path $pf) { L ($f + ' tail: ' + (((Get-Content $pf -Tail 4 -ErrorAction SilentlyContinue) -join ' | '))) }
    }
}

$script:node = Resolve-NodeExe
$script:bin = Resolve-DshBin
L ('node=' + $script:node)
L ('bin =' + $script:bin)
if (-not $script:node -or -not $script:bin) { L 'ABORT: could not resolve node or the dsh bin script'; exit 1 }
$coreVersion = Get-CoreVersion
L ('core version on disk: ' + $coreVersion)

# 1) stop the old server (and verify it is really gone)
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
    $old = [int]$conn.OwningProcess
    L ('old server pid = ' + $old)
    taskkill /PID $old /T /F 2>&1 | ForEach-Object { L ('taskkill> ' + $_) }
    for ($i = 0; $i -lt 12; $i++) { Start-Sleep -Milliseconds 700; if (-not (Get-Process -Id $old -ErrorAction SilentlyContinue)) { break } }
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) { L 'taskkill failed -> Stop-Process fallback'; Stop-Process -Id $old -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) { L ('ABORT: pid ' + $old + ' survived - nothing was changed'); exit 1 }
    L 'old server stopped (verified)'
} else { L 'no listener on 3080 - nothing to kill' }
Start-Sleep -Seconds 3
Clear-DeadProbeLock

# 2) boot probe: the real test of the new core
$probeOk = Invoke-BootProbe -TimeoutSeconds $ProbeTimeoutSeconds
L ('boot probe: ' + $probeOk)
$downgraded = $false
if (-not $probeOk) {
    L ('probe FAILED - reinstalling fallback core ' + $FallbackVersion)
    $npmCli = Join-Path (Split-Path $script:node -Parent) 'node_modules\npm\bin\npm-cli.js'
    if (Test-Path $npmCli) {
        & $script:node $npmCli 'i' '-g' ('@deepseek-ai/dsh@' + $FallbackVersion) '--no-fund' '--no-audit' 2>&1 | ForEach-Object { L ('npm> ' + $_) }
    } else { L ('npm cli not found at ' + $npmCli) }
    $downgraded = $true
    $coreVersion = Get-CoreVersion
    L ('core version after downgrade: ' + $coreVersion)
    $probeOk = Invoke-BootProbe -TimeoutSeconds $ProbeTimeoutSeconds
    L ('boot probe after downgrade: ' + $probeOk)
}

# 3) start the server (the hardened launcher resolves node itself)
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\dhs01\dsh-desktop\start-server.ps1' | Out-Null
$httpOk = $false
$waited = 0
for ($i = 0; $i -lt $ReadyTimeoutSeconds; $i++) {
    Start-Sleep -Seconds 1
    $waited = $i
    try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -eq 200) { $httpOk = $true; break } } catch { }
}
$conn2 = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$newPid = 0
if ($conn2) { $newPid = [int]$conn2.OwningProcess }
L ('server ready: http200=' + $httpOk + ' pid=' + $newPid + ' waited=' + $waited + 's')
if ($httpOk) { L 'verdict: PASS (new core serving)' } else { L 'verdict: FAIL - check dsh-server.log' }

$obj = [pscustomobject]@{
    at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    coreOnDisk = $coreVersion
    fallbackVersion = $FallbackVersion
    probeOk = $probeOk
    downgraded = $downgraded
    http200 = $httpOk
    newPid = $newPid
}
[System.IO.File]::WriteAllText($report, ($obj | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
L '=== core upgrade restart done ==='
exit 0
