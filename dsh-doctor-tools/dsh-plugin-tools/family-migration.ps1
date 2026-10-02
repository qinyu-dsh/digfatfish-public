# family-migration.ps1 - SCHEDULED TASK ONLY (the kill step takes down the caller's session).
# Core 0.1.1-rc.2 -> 0.1.5-rc.1; family @linxin666/dsh-web-ui-all 0.3.6 -> @linxin666/dsh-web-all 0.3.23.
# Writes a state marker per phase so the independent rescue task can tell 'still migrating'
# from 'failed' and roll back immediately.
param(
    [string]$TargetCore = '0.1.5-rc.1',
    [string]$PreviousCore = '0.1.1-rc.2',
    [string]$BackupDir = 'D:\dhs01\dsh-profile-backup\pre-family-migration-20260919-20143',
    [int]$DelaySeconds = 120,
    [int]$ProbeTimeoutSeconds = 90,
    [int]$ReadyTimeoutSeconds = 150
)
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log = Join-Path $root 'family-migration.log'
$report = Join-Path $root 'family-migration.report.json'
$marker = Join-Path $root 'family-migration.state.json'
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\web'

function L([string]$m) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}
function Set-State([string]$status, [string]$step, [string]$detail) {
    $o = [pscustomobject]@{ status = $status; step = $step; detail = $detail; at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') }
    [System.IO.File]::WriteAllText($marker, ($o | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding($false)))
}
# Put the previous global core back from the stash the core step leaves behind. Called on every
# failure path: a rolled-back profile on a NEW core is the 2026-09-21 outage, and a new profile
# on the OLD core is the 2026-09-22 probe failure. Never leave either combination behind.
function Restore-StashedCore {
    $stashFile = Join-Path $root 'core-stash.txt'
    if (-not (Test-Path $stashFile)) { return }
    $stash = (Get-Content $stashFile -Raw).Trim()
    $globalCore = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh'
    if (-not $stash -or -not (Test-Path $stash)) { return }
    Remove-Item $globalCore -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item $stash $globalCore -Force -ErrorAction SilentlyContinue
    Remove-Item $stashFile -Force -ErrorAction SilentlyContinue
    L ('core restored from stash -> ' + $globalCore)
}
# Health probe that survives the launch-token gate: the plugin API answers without a token on
# every core version, while newer cores gate the index page behind '?token=...'.
function Test-Alive([string]$base) {
    try { $r = Invoke-WebRequest ($base + 'api/plugin-manager/failures') -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { return $true } } catch { }
    try { $r = Invoke-WebRequest $base -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { return $true } } catch { if ($_.Exception.Response -ne $null) { return $true } }
    return $false
}

$nodeDir = 'D:\dsh\node'
if ((Test-Path (Join-Path $nodeDir 'node.exe')) -and ($env:PATH -notlike ('*' + $nodeDir + '*'))) { $env:PATH = $nodeDir + ';' + $env:PATH }
$node = 'D:\dsh\node\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
$npmCli = Join-Path (Split-Path $node -Parent) 'node_modules\npm\bin\npm-cli.js'
$pnpmCli = Join-Path $env:APPDATA 'npm\node_modules\pnpm\bin\pnpm.cjs'
if (-not (Test-Path $pnpmCli)) { $pnpmCli = Join-Path $env:LOCALAPPDATA 'pnpm\pnpm.cjs' }
$binJs = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$startServer = 'D:\dhs01\dsh-desktop\start-server.ps1'
$serverLog = 'D:\dhs01\dsh-desktop\dsh-server.log'

Set-State 'migrating' 'preflight' ''
$need = @('package.json','cordis.patch.yml','pnpm-lock.yaml','pnpm-workspace.yaml')
$missing = @()
foreach ($f in $need) { if (-not (Test-Path (Join-Path $BackupDir $f))) { $missing += $f } }
if (-not (Test-Path (Join-Path $BackupDir 'sessions-db\sessions.sqlite'))) { $missing += 'sessions-db/sessions.sqlite' }
if ($missing.Count -gt 0) { Set-State 'failed' 'preflight' 'backup incomplete'; L ('ABORT: backup incomplete: ' + ($missing -join ', ')); exit 1 }
L ('backup verified: ' + $BackupDir)
L '=== family migration: scheduled run ==='
if ($DelaySeconds -gt 0) { L ('delay ' + $DelaySeconds + 's'); Start-Sleep -Seconds $DelaySeconds }
if (-not (Test-Path $node) -or -not (Test-Path $binJs)) { Set-State 'failed' 'resolve' 'node or bin.js missing'; L 'ABORT: cannot resolve node/bin.js'; exit 1 }
$coreBefore = (& $node $binJs --version 2>&1 | Select-Object -First 1)
L ('core before: ' + $coreBefore)

Set-State 'migrating' 'stop' ''
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
    $old = [int]$conn.OwningProcess
    L ('old server pid = ' + $old)
    taskkill /PID $old /T /F 2>&1 | ForEach-Object { L ('taskkill> ' + $_) }
    for ($i = 0; $i -lt 12; $i++) { Start-Sleep -Milliseconds 700; if (-not (Get-Process -Id $old -ErrorAction SilentlyContinue)) { break } }
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) { Set-State 'failed' 'stop' 'old server survived'; L 'ABORT: old server survived'; exit 1 }
    L 'old server stopped (verified)'
} else { L 'no listener on 3080' }
Start-Sleep -Seconds 2

Set-State 'migrating' 'core' ''
L ('installing core ' + $TargetCore)
# npm first, kept for the day upstream publishes a self-consistent rc. Right now every published
# 0.1.5-rcN meta-package floats its sub-dependencies with ^, so npm resolves the newest 0.1.5-rc.3
# sub-packages -- and @deepseek-ai/dsh-client-ui-sidebar-documentpreview was never published at
# rc.3, so the install dies with ETARGET and the core silently stays on $PreviousCore. That is how
# the 2026-09-22 run put the NEW plugin tree on the OLD core (SessionSeq / SessionLogOffset missing
# from the old dsh-session) and failed the boot probe. So: verify the version, and fall back to the
# staged warm core -- a complete rc.2 sub-package tree that already boots (the rehearsal ran it).
& $node $npmCli 'i' '-g' ('@deepseek-ai/dsh@' + $TargetCore) '--no-fund' '--no-audit' 2>&1 | ForEach-Object { L ('npm> ' + $_) }
$coreAfter = (& $node $binJs --version 2>&1 | Select-Object -First 1)
L ('core after npm: ' + $coreAfter)
if ($coreAfter -ne $TargetCore) {
    $stagedCore = 'D:\dhs01\_core_warm\node_modules\@deepseek-ai\dsh'
    $globalCore = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh'
    L ('npm left the core at ' + $coreAfter + ' -> staging from ' + $stagedCore)
    if (-not (Test-Path (Join-Path $stagedCore 'lib\bin.js'))) { Set-State 'failed' 'core' 'npm failed and no staged core'; L 'ABORT: no core source available'; exit 1 }
    $coreStash = Join-Path $env:APPDATA ('npm\node_modules\@deepseek-ai\dsh.stash-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    if (Test-Path $globalCore) {
        Move-Item $globalCore $coreStash -Force
        [System.IO.File]::WriteAllText((Join-Path $root 'core-stash.txt'), $coreStash, (New-Object System.Text.UTF8Encoding($false)))
        L ('stashed previous core -> ' + $coreStash)
    }
    Copy-Item $stagedCore $globalCore -Recurse -Force
    $coreAfter = (& $node $binJs --version 2>&1 | Select-Object -First 1)
    L ('core after staged copy: ' + $coreAfter)
}
if ($coreAfter -ne $TargetCore) { Set-State 'failed' 'core' ('core is ' + $coreAfter + ' but ' + $TargetCore + ' is required'); L ('ABORT: core version mismatch (' + $coreAfter + ') - profile left untouched'); exit 1 }
L ('core verified: ' + $coreAfter)

Set-State 'migrating' 'profile-files' ''
& $node (Join-Path $root 'family-migration-profile.mjs') '--apply' 2>&1 | ForEach-Object { L ('surgery> ' + $_) }
$obsolete = Join-Path $profile 'patches\modlens-3.18.2-preparecall.patch'
if (Test-Path $obsolete) { Remove-Item $obsolete -Force; L 'removed obsolete modlens 3.18.2 patch file' }

Set-State 'migrating' 'pnpm-install' ''
L 'pnpm install -w'
L ('pnpm cli: ' + $pnpmCli + ' (exists=' + (Test-Path $pnpmCli) + ')')
& $node $pnpmCli 'install' '-w' '--dir' $profile '--prefer-offline' '--reporter=append-only' 2>&1 | ForEach-Object { L ('pnpm> ' + $_) }
if ($LASTEXITCODE -ne 0) { Set-State 'failed' 'pnpm-install' ('pnpm exit ' + $LASTEXITCODE); L ('ABORT: pnpm install failed with exit ' + $LASTEXITCODE); exit 1 }
$installed = '?'
try { $installed = (Get-Content (Join-Path $profile 'package.json') -Raw | ConvertFrom-Json).dependencies.'@linxin666/dsh-web-all' } catch {}
L ('family version in package.json: ' + $installed)
$famPkg = Join-Path $profile 'node_modules\@linxin666\dsh-web-all\package.json'
if (Test-Path $famPkg) { L ('node_modules family: ' + (Get-Content $famPkg -Raw -Encoding UTF8 | ConvertFrom-Json).version) }
else { Set-State 'failed' 'pnpm-install' 'dsh-web-all missing from node_modules'; L 'ABORT: node_modules/@linxin666/dsh-web-all missing after install'; exit 1 }

# 4b) fresh DB backup + v1 -> v2 prefix (the new session-rdb rejects user_version 1 and its v3
#     migrations assume the v2 column layout).
Set-State 'migrating' 'db-prefix' ''
$dbDir = Join-Path $env:USERPROFILE '.dsh\sessions'
$dbInWindow = Join-Path $BackupDir 'sessions-db-pre-window'
New-Item -ItemType Directory -Path $dbInWindow -Force | Out-Null
foreach ($f in @('sessions.sqlite','sessions.sqlite-wal','sessions.sqlite-shm')) {
    $srcDb = Join-Path $dbDir $f
    if (Test-Path $srcDb) { Copy-Item $srcDb (Join-Path $dbInWindow $f) -Force; L ('db backup: ' + $f) }
}
& $node (Join-Path $root 'session-db-prefix.cjs') '--apply' 2>&1 | ForEach-Object { L ('dbprefix> ' + $_) }

Set-State 'migrating' 'probe' ''
$probeLog = Join-Path $root 'family-migration-probe.log'
Remove-Item $probeLog -Force -ErrorAction SilentlyContinue
$probeCmd = "& '" + $node + "' '" + $binJs + "' --profile web --no-open --port 0"
$bootstrap = "`$ErrorActionPreference='Continue'; " + $probeCmd + " *>> '" + $probeLog + "'"
$pr = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command',$bootstrap -WindowStyle Hidden -PassThru
$url = $null
for ($i = 0; $i -lt $ProbeTimeoutSeconds; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $probeLog) {
        $m = Select-String -Path $probeLog -Pattern 'http://127[.]0[.]0[.]1:[0-9]+' | Select-Object -First 1
        if ($m) { $url = $m.Matches[0].Value; break }
    }
    if ($pr.HasExited) { break }
}
$probeOk = $false
if ($url) {
    $probeBase = $url -replace '[?].*$', ''
    if ($probeBase -notlike '*/') { $probeBase = $probeBase + '/' }
    for ($j = 0; $j -lt 20; $j++) { if (Test-Alive $probeBase) { $probeOk = $true; break }; Start-Sleep -Milliseconds 800 }
}
if (-not $pr.HasExited) { taskkill /PID $pr.Id /T /F 2>&1 | Out-Null }
Start-Sleep -Seconds 2
$lock = Join-Path $env:USERPROFILE '.dsh\task-board\ledger-v2.lock'
if (Test-Path $lock) {
    try { $owner = Get-Content $lock -Raw -Encoding UTF8 | ConvertFrom-Json; if ($null -eq (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue)) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; L 'cleared probe task-board lock (dead owner)' } }
    catch { Remove-Item $lock -Force -ErrorAction SilentlyContinue; L 'cleared unreadable probe lock' }
}
L ('boot probe: ' + $probeOk + ' (url ' + $url + ')')
if (-not $probeOk) {
    Set-State 'failed' 'probe' 'new core+tree could not boot; rescue will roll back'
    Restore-StashedCore
    if (Test-Path $probeLog) { L ('probe tail: ' + (((Get-Content $probeLog -Tail 8 -ErrorAction SilentlyContinue) -join ' | '))) }
    $o = [pscustomobject]@{ at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); coreBefore = $coreBefore; coreAfter = $coreAfter; family = $installed; probeOk = $false; http200 = $false; verdict = 'PROBE_FAILED' }
    [System.IO.File]::WriteAllText($report, ($o | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding($false)))
    L 'PROBE FAILED - rescue task will roll back'
    exit 1
}

Set-State 'migrating' 'start' ''
if (Test-Path $startServer) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startServer | Out-Null } else { L ('launcher missing: ' + $startServer) }
$httpOk = $false
for ($i = 0; $i -lt $ReadyTimeoutSeconds; $i++) { Start-Sleep -Seconds 1; if (Test-Alive 'http://127.0.0.1:3080/') { $httpOk = $true; break } }
$conn2 = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$newPid = 0
if ($conn2) { $newPid = [int]$conn2.OwningProcess }
L ('server ready: http200=' + $httpOk + ' pid=' + $newPid)

$verify = [pscustomobject]@{ safeMode = $null; failures = -1; familyInstalled = $false; familyInManifest = $false; clientBundles = 0; brokenBundles = 0 }
try {
    $fj = (Invoke-WebRequest 'http://127.0.0.1:3080/api/plugin-manager/failures' -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json
    $verify.safeMode = [bool]$fj.safeMode
    $verify.failures = @($fj.items).Count
} catch { L ('verify: failures endpoint failed: ' + $_.Exception.Message) }
if (Test-Path (Join-Path $profile 'node_modules\@linxin666\dsh-web-all\package.json')) { $verify.familyInstalled = $true; L 'verify: family package present in profile node_modules' }
try {
    $pl = (Invoke-WebRequest 'http://127.0.0.1:3080/api/plugin-manager/list' -UseBasicParsing -TimeoutSec 15).Content | ConvertFrom-Json
    $verify.familyInstalled = $verify.familyInstalled -or (@($pl.plugins) | Where-Object { $_.id -eq '@linxin666/dsh-web-all' }).Count -gt 0
} catch { L ('verify: plugin list endpoint failed: ' + $_.Exception.Message) }
$token = ''
for ($tk = 0; $tk -lt 25; $tk++) {
    # dsh-server.log mixes UTF-8 stdout with UTF-16LE 'start-server:' lines, and PS 5.1's
    # default ANSI decoding lets multi-byte Chinese swallow the ASCII that follows it --
    # which is why the token never matched before. Read as UTF-8 (measured working).
    try {
        $sv = (Get-Content $serverLog -Tail 300 -Encoding UTF8 -ErrorAction Stop) -join "`n"
        $ms = [regex]::Matches($sv, 'token=([A-Za-z0-9_\-]{8,})')
        if ($ms.Count -gt 0) { $token = $ms[$ms.Count - 1].Groups[1].Value; break }
    } catch { }
    Start-Sleep -Seconds 1
}
L ('verify: launch token found=' + [bool]$token)
$indexUrl = 'http://127.0.0.1:3080/' + $(if ($token) { '?token=' + $token } else { '' })
try {
    # Before fetching the token-gated index, open a session so the auth cookie the
    # token endpoint sets is reused for the bundle-liveness fetches below.
    $sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $html = ''
    try { $html = (Invoke-WebRequest $indexUrl -UseBasicParsing -TimeoutSec 15 -WebSession $sess).Content }
    catch {
        if ($token) { try { $html = (Invoke-WebRequest ('http://127.0.0.1:3080/?token=' + $token) -UseBasicParsing -TimeoutSec 15 -WebSession $sess).Content } catch { } }
        if (-not $html) { throw }
    }
    $verify.familyInManifest = ($html -match 'dsh-web-all')
    $urls = [regex]::Matches($html, '/plugins/[A-Za-z0-9@._/-]+client[.]js[?]rev=[0-9a-f]+') | ForEach-Object { $_.Value } | Select-Object -Unique
    $verify.clientBundles = $urls.Count
    $bad = 0
    foreach ($u in $urls) {
        $suffix = if ($token) { '&token=' + $token } else { '' }
        try { $rr = Invoke-WebRequest ('http://127.0.0.1:3080' + $u) -UseBasicParsing -TimeoutSec 10 -WebSession $sess; if ($rr.StatusCode -ne 200) { $bad++ } } catch { $bad++ }
    }
    $verify.brokenBundles = $bad
    L ('verify: client bundles=' + $urls.Count + ' broken=' + $bad)
} catch { L ('verify: index fetch failed: ' + $_.Exception.Message) }
$verifyOk = $httpOk -and ($verify.safeMode -eq $false) -and ($verify.failures -eq 0) -and ($verify.familyInstalled -or $verify.familyInManifest) -and ($verify.brokenBundles -eq 0)
L ('verify verdict: safeMode=' + $verify.safeMode + ' failures=' + $verify.failures + ' familyInstalled=' + $verify.familyInstalled + ' familyInManifest=' + $verify.familyInManifest + ' bundles=' + $verify.clientBundles + ' broken=' + $verify.brokenBundles + ' => ok=' + $verifyOk)
if ($verifyOk) { Set-State 'done' 'verify' ('pid ' + $newPid) } else { Set-State 'failed' 'verify' 'acceptance failed'; Restore-StashedCore }
$o = [pscustomobject]@{ at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); coreBefore = $coreBefore; coreAfter = $coreAfter; family = $installed; probeOk = $probeOk; httpOk = $httpOk; safeMode = $verify.safeMode; failures = $verify.failures; familyInstalled = $verify.familyInstalled; familyInManifest = $verify.familyInManifest; clientBundles = $verify.clientBundles; brokenBundles = $verify.brokenBundles; newPid = $newPid; backupDir = $BackupDir; verdict = $(if ($verifyOk) { 'PASS' } else { 'FAIL' }) }
[System.IO.File]::WriteAllText($report, ($o | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding($false)))
L ('=== family migration done: ' + $o.verdict + ' ===')
exit 0
