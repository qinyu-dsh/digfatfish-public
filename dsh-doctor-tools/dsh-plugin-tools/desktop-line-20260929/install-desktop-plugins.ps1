#requires -Version 7
<#
  Install the full 0.2-line plugin set into the official DeepSeek Harness Desktop
  profile, on top of @morlay/better-session (RDB session store).

  Order (each step logged, everything reversible):
    1. stop the desktop app (it owns port 19387 and must be closed for plugin installs)
    2. back up: consistent DB snapshot + the four profile manifests
    3. normalize pnpm-workspace.yaml (allowBuilds / minimumReleaseAge) so pnpm's
       build gate and release-age gate do not fail the install
    4. install the package set (registry specs; local tarballs as fallback)
    5. verify: dependencies, bundle layers, installed trees
    6. enable the family rows the imported settings rely on (liangshen preset)
    7. rehearse on a COPY: probe home + DB copy + the real node_modules junctioned in;
       boots a second instance and asserts stored sessions + client bundles
    8. on green: relaunch the app; on red: restore manifests, relaunch anyway
    9. write a JSON report

  Never run this from inside a DSH session: step 1 kills the app that hosts it.
#>
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [int]$ProbePort = 19411,
  [switch]$SkipRelaunch
)

$ErrorActionPreference = 'Stop'
$appExe  = 'E:\deepseek\DSH\DeepSeek Harness.exe'
$cliCmd  = 'E:\deepseek\DSH\resources\runtime\cli\bin\dsh.cmd'
$nodeExe = 'D:\dsh\node\node.exe'
$build   = 'E:\deepseek\_build'
$plugDir = 'E:\deepseek\plug-in\for-core-0.2.0'
$ts      = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup  = "D:\dhs01\backups\desktop-plugins-$ts"
$log     = "$build\install-desktop-plugins-$ts.log"
$profile = Join-Path $DshHome 'profiles\desktop'
$manifests = @('package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml')
$packages = @(
  '@linxin666/dsh-web-all@0.4.4',
  'dsh-better-sidebar@0.24.1',
  '@liustack/modlens@3.26.5',
  'dsh-meme@0.1.44',
  'dsh-routing-suite@0.1.2',
  '@morlay/better-session@0.1.3'
)
# dsh-at-file@0.6.3 is deliberately absent: the rehearsal boot logged
# "dsh-at-file (dsh-at-file): failed to import" against runtime 0.2.0-rc.2.
$bundleOrder = @(
  '@linxin666/dsh-web-all',
  '@liustack/modlens',
  'dsh-meme',
  'dsh-routing-suite',
  'dsh-better-sidebar',
  '@morlay/better-session'   # last: it disables the shipped JSONL persistence and the stock conversation shell
)
$report  = [ordered]@{ startedAt = (Get-Date).ToString('s'); backupDir = $backup; packages = $packages; steps = @() }

New-Item -ItemType Directory -Force -Path $backup, $build | Out-Null

function Say {
  param([string]$Message, [string]$Level = 'INFO')
  $line = '[{0}] {1,-4} {2}' -f (Get-Date -Format 'HH:mm:ss'), $Level, $Message
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding utf8
}
function Step {
  param([string]$Name, [bool]$Ok, [string]$Detail = '')
  $script:report.steps += [ordered]@{ name = $Name; ok = $Ok; detail = $Detail }
  Say ("{0} :: {1}{2}" -f $Name, $(if ($Ok) { 'PASS' } else { 'FAIL' }), $(if ($Detail) { " :: $Detail" } else { '' })) $(if ($Ok) { 'OK' } else { 'FAIL' })
}
function Test-Port { param([int]$Port) [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) }
function Get-AppProcesses {
  Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
    Where-Object { $_.CommandLine -notmatch '--type=' }
}
function Remove-Junction {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  # rmdir removes the link itself; Remove-Item -Recurse could follow it into the target.
  & cmd /c rmdir "$Path" 2>&1 | Out-Null
}

function Stop-DesktopApp {
  $procs = @(Get-AppProcesses)
  if ($procs.Count -eq 0) { Say 'desktop app is not running'; return (-not (Test-Port 19387)) }
  foreach ($p in $procs) { Say ("stopping pid {0}" -f $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 1; if (-not (Test-Port 19387)) { break } }
  foreach ($p in @(Get-AppProcesses)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  return -not (Test-Port 19387)
}

function Backup-Everything {
  $env:DSH_SRC_DB = Join-Path $DshHome 'sessions\sessions.sqlite'
  $env:DSH_DST_DB = Join-Path $backup 'sessions.sqlite.snapshot'
  & $nodeExe (Join-Path $build 'vacuum-into.mjs')
  if ($LASTEXITCODE -ne 0) { throw "DB snapshot failed (exit $LASTEXITCODE)" }
  foreach ($name in $manifests) { Copy-Item (Join-Path $profile $name) $backup -Force }
  $size = (Get-Item (Join-Path $backup 'sessions.sqlite.snapshot')).Length
  return ("snapshot {0:N1} MB + {1} manifests" -f ($size / 1MB), $manifests.Count)
}

function Initialize-PnpmWorkspace {
  & $nodeExe (Join-Path $build 'normalize-workspace.mjs') (Join-Path $profile 'pnpm-workspace.yaml') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'pnpm-workspace.yaml normalization failed' }
  $text = Get-Content (Join-Path $profile 'pnpm-workspace.yaml') -Raw
  $allow = @($text -split "`n" | Where-Object { $_ -match '^allowBuilds:' }).Count
  $age = @($text -split "`n" | Where-Object { $_ -match '^minimumReleaseAge:' }).Count
  Step 'workspace:gates' ($allow -eq 1 -and $age -eq 1) "allowBuilds blocks=$allow minimumReleaseAge blocks=$age"
}

function Install-Plugins {
  $env:DSH_HOME = $DshHome
  Say ("installing {0} packages (registry)" -f $packages.Count)
  $out = & $cliCmd plugin --profile desktop add @packages 2>&1
  $rc = $LASTEXITCODE
  $out | Add-Content -Path $log -Encoding utf8
  $out | ForEach-Object { if ("$_" -match 'dsh:|ERR_|error|WARN') { Write-Host "    $_" } }
  if ($rc -ne 0) {
    Say "registry install failed (rc=$rc); retrying with local tarballs" 'WARN'
    $tgz = @(Get-ChildItem (Join-Path $plugDir '*.tgz') | ForEach-Object { $_.FullName })
    Say ("local tarballs: {0}" -f $tgz.Count)
    $out2 = & $cliCmd plugin --profile desktop add @tgz 2>&1
    $rc = $LASTEXITCODE
    $out2 | Add-Content -Path $log -Encoding utf8
    $out2 | ForEach-Object { if ("$_" -match 'dsh:|ERR_|error|WARN') { Write-Host "    $_" } }
  }
  if ($rc -ne 0) { throw "plugin install failed (rc=$rc); see $log" }

  $manifest = Get-Content (Join-Path $profile 'package.json') -Raw | ConvertFrom-Json
  $bundles = @($manifest.dsh.profile.bundles)
  $missingDep = @()
  $missingTree = @()
  $missingBundle = @()
  foreach ($spec in $packages) {
    $name = ($spec -split '@(?=[^@]*$)')[0]
    if ($name.StartsWith('@')) { $name = ($spec -split '@')[0..1] -join '@' }
    if (-not $manifest.dependencies.PSObject.Properties.Name.Contains($name)) { $missingDep += $name; continue }
    $pkgJson = Join-Path $profile "node_modules\$name\package.json"
    if (-not (Test-Path $pkgJson)) { $missingTree += $name; continue }
    $declares = (Get-Content $pkgJson -Raw | ConvertFrom-Json).dsh.bundle.patch
    if ($declares -and ($bundles -notcontains $name)) { $missingBundle += $name }
  }
  Step 'install:dependencies' ($missingDep.Count -eq 0) ("missing: " + ($(if ($missingDep.Count) { $missingDep -join ', ' } else { 'none' })))
  Step 'install:trees' ($missingTree.Count -eq 0) ("missing: " + ($(if ($missingTree.Count) { $missingTree -join ', ' } else { 'none' })))
  Step 'install:bundle-layers' ($missingBundle.Count -eq 0) ("bundles: " + ($bundles -join ' -> '))
  $report.bundles = $bundles
  if ($missingDep.Count -or $missingTree.Count -or $missingBundle.Count) { throw 'install verification failed' }
}

function Ensure-BundleLayers {
  $out = & $nodeExe (Join-Path $build 'ensure-bundles.mjs') $profile @bundleOrder 2>&1
  if ($LASTEXITCODE -ne 0) { throw "bundle layer reconciliation failed: $out" }
  $parsed = $out | ConvertFrom-Json
  Step 'bundles:layers' ($parsed.bundles[-1] -eq '@morlay/better-session' -and $parsed.notInstalled.Count -eq 0) ($parsed.bundles -join ' -> ')
  $report.bundles = @($parsed.bundles)
}

function Enable-FamilyOptIns {
  $patchPath = Join-Path $profile 'cordis.patch.yml'
  $text = Get-Content $patchPath -Raw
  if ($text -notmatch 'id:\s*web-ui-liangshen') {
    Add-Content -Path $patchPath -Value "`n# enabled by install-desktop-plugins.ps1: the imported settings use the liangshen default preset`n- id: web-ui-liangshen`n  disabled: false`n" -Encoding utf8
    Step 'family:liangshen' $true 'wrote disabled:false override (default agent preset)'
  } else {
    Step 'family:liangshen' $true 'override already present'
  }
}

function Invoke-Probe {
  param([string]$SnapshotPath)
  $probeHome = Join-Path $build "probe-rdb-$ts"
  $probeProfile = Join-Path $probeHome 'profiles\desktop-probe'
  New-Item -ItemType Directory -Force -Path $probeProfile, (Join-Path $probeHome 'sessions') | Out-Null
  foreach ($name in $manifests) { Copy-Item (Join-Path $profile $name) $probeProfile -Force }
  # The probe profile must OWN its node_modules. A junction into the real profile puts every importer's
  # real path outside the active home's profiles tree, so the runtime stops supplying the core packages
  # (@deepseek-ai/dsh-*): the probe then reports bogus "failed to import" and the whole run rolls back.
  # That is exactly what happened on 2026-09-29 22:24 (session-rdb). Install in place instead - with a
  # warm pnpm store it costs ~7s.
  Remove-Junction (Join-Path $probeProfile 'node_modules')
  $env:DSH_HOME = $probeHome
  Say 'installing the probe profile in place (same package set, own node_modules)'
  $probeInstall = & $cliCmd plugin --profile desktop-probe install 2>&1
  $probeInstallRc = $LASTEXITCODE
  $probeInstall | Add-Content -Path $log -Encoding utf8
  Step 'probe:install' ($probeInstallRc -eq 0 -and (Test-Path (Join-Path $probeProfile 'node_modules\@morlay\session-rdb\package.json'))) "rc=$probeInstallRc"
  Copy-Item $SnapshotPath (Join-Path $probeHome 'sessions\sessions.sqlite') -Force
  foreach ($extra in @('.credentials.yaml', 'pet.json', 'dsh-expression.json')) {
    $src = Join-Path $DshHome $extra
    if (Test-Path $src) { Copy-Item $src (Join-Path $probeHome $extra) -Force }
  }

  $env:DSH_HOME = $probeHome
  $outFile = Join-Path $probeHome 'probe.out'
  $errFile = Join-Path $probeHome 'probe.err'
  Say "booting probe instance (profile desktop-probe, port $ProbePort)"
  $proc = Start-Process -FilePath $cliCmd -ArgumentList '--profile', 'desktop-probe', '--no-open', '--port', "$ProbePort" `
    -RedirectStandardOutput $outFile -RedirectStandardError $errFile -WindowStyle Hidden -PassThru

  $listening = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Port $ProbePort) { $listening = $true; Say "probe listening after $($i + 1)s"; break }
    if ($proc.HasExited) { break }
  }
  if (-not $listening) {
    $errTail = ((Get-Content $errFile -Tail 15 -ErrorAction SilentlyContinue) -join ' | ')
    $outTail = ((Get-Content $outFile -Tail 15 -ErrorAction SilentlyContinue) -join ' | ')
    Step 'probe:boot' $false "no listener on $ProbePort; stderr=$errTail; stdout=$outTail"
    return $false
  }
  Start-Sleep -Seconds 2
  $stdout = [string](Get-Content $outFile -Raw -ErrorAction SilentlyContinue)
  $token = ([regex]::Match($stdout, '\?token=([A-Za-z0-9_\-]+)')).Groups[1].Value
  if (-not $token) { Step 'probe:token' $false 'no launch token in probe stdout'; return $false }
  Step 'probe:boot' $true "listening on $ProbePort"

  & $nodeExe (Join-Path $build 'probe-rdb.mjs') $ProbePort $token 'dsh大更新' '虫巢拓展' 'd指导更新' 2>&1 |
    ForEach-Object { Write-Host "    $_"; Add-Content -Path $log -Value "    $_" -Encoding utf8 }
  $probeRc = $LASTEXITCODE
  Step 'probe:assertions' ($probeRc -eq 0) "probe exit code $probeRc"

  $bootErrors = @()
  foreach ($file in @($outFile, $errFile)) {
    $text = [string](Get-Content $file -Raw -ErrorAction SilentlyContinue)
    foreach ($pattern in @('plugin tree failed to load', 'failed to import loader entry', 'StartupError', 'safe mode')) {
      if ($text -match [regex]::Escape($pattern)) { $bootErrors += "$([System.IO.Path]::GetFileName($file)):$pattern" }
    }
  }
  Step 'probe:no-boot-errors' ($bootErrors.Count -eq 0) ($bootErrors -join ', ')

  $owner = (Get-NetTCPConnection -State Listen -LocalPort $ProbePort -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
  if ($owner) { Say "tearing down probe pid $owner"; & taskkill /PID $owner /T /F 2>&1 | Out-Null }
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 20; $i++) { if (-not (Test-Port $ProbePort)) { break }; Start-Sleep -Seconds 1 }
  Step 'probe:teardown' (-not (Test-Port $ProbePort)) "port $ProbePort free again"
  $report.probeHome = $probeHome
  return ($probeRc -eq 0 -and $bootErrors.Count -eq 0)
}

function Restore-Manifests {
  Say 'rolling back profile manifests and dropping the installed tree' 'WARN'
  foreach ($name in $manifests) { Copy-Item (Join-Path $backup $name) $profile -Force }
  Remove-Item (Join-Path $profile 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $profile 'pnpm-lock.yaml') -Force -ErrorAction SilentlyContinue
  $manifest = Get-Content (Join-Path $profile 'package.json') -Raw | ConvertFrom-Json
  Step 'rollback:manifests' (@($manifest.dsh.profile.bundles).Count -le 2) (@($manifest.dsh.profile.bundles) -join ' -> ')
}

function Start-DesktopApp {
  if ($SkipRelaunch) { Say 'skipping app relaunch (-SkipRelaunch)'; return $true }
  Say 'relaunching DeepSeek Harness Desktop'
  # The probe run points DSH_HOME at the throwaway rehearsal home; if that leaks into the relaunch the
  # app boots against the probe home and the user's sidebar comes up empty (this happened 2026-09-29 22:24).
  foreach ($envName in @('DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL')) {
    Remove-Item -LiteralPath ("Env:{0}" -f $envName) -ErrorAction SilentlyContinue
  }
  Say ("launching with DSH_HOME cleared (real home: {0})" -f $DshHome)
  Start-Process -FilePath $appExe | Out-Null
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Port 19387) { Step 'app:listen' $true "19387 up after $($i + 1)s"; return $true }
  }
  Step 'app:listen' $false '19387 never came up within 120s'
  return $false
}
function Test-AppAnswers {
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:19387/' -SkipHttpErrorCheck -TimeoutSec 15
    $ok = $response.StatusCode -in 200, 401
    Step 'app:http' $ok "status $($response.StatusCode)"
    return $ok
  } catch {
    Step 'app:http' $false $_.Exception.Message
    return $false
  }
}
function Get-DbFacts {
  param([string]$SourceDb, [string]$Label, [switch]$Live)
  $tmp = Join-Path $build "dbcopy-$Label-$ts"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $target = Join-Path $tmp 'sessions.sqlite'
  if ($Live) {
    $env:DSH_SRC_DB = $SourceDb
    $env:DSH_DST_DB = $target
    & $nodeExe (Join-Path $build 'vacuum-into.mjs') 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      foreach ($suffix in @('', '-wal', '-shm')) { if (Test-Path "$SourceDb$suffix") { Copy-Item "$SourceDb$suffix" "$target$suffix" -Force } }
    }
  } else { Copy-Item $SourceDb $target -Force }
  $facts = & $nodeExe (Join-Path $build 'db-facts.mjs') $target 2>&1
  return ($facts -join "`n")
}

# ------------------------------------------------------------------- run it
Say "=== install desktop plugin set :: backup -> $backup ==="
$failed = $false
try {
  Step 'stop:app' (Stop-DesktopApp) 'port 19387 free'
  Step 'backup:snapshot' $true (Backup-Everything)
  Initialize-PnpmWorkspace
  Install-Plugins
  Ensure-BundleLayers
  Enable-FamilyOptIns
  $report.dbBefore = Get-DbFacts (Join-Path $backup 'sessions.sqlite.snapshot') 'before'
  Say 'pre-switch DB facts:'
  Say $report.dbBefore

  if (Invoke-Probe -SnapshotPath (Join-Path $backup 'sessions.sqlite.snapshot')) {
    Say 'probe GREEN - relaunching the app against the real DB' 'OK'
  } else {
    Say 'probe RED - restoring the previous profile' 'WARN'
    $failed = $true
    Restore-Manifests
  }
} catch {
  Step 'fatal' $false $_.Exception.Message
  Say "fatal: $($_.Exception.Message)" 'FAIL'
  $failed = $true
  try { if (Test-Path (Join-Path $backup 'package.json')) { Restore-Manifests } } catch { Say "rollback failed: $($_.Exception.Message)" 'FAIL' }
}

Start-DesktopApp | Out-Null
Test-AppAnswers | Out-Null
Start-Sleep -Seconds 8
$report.dbAfter = Get-DbFacts (Join-Path $DshHome 'sessions\sessions.sqlite') 'after' -Live
Say 'post-switch DB facts:'
Say $report.dbAfter
$report.failed = $failed
$report.finishedAt = (Get-Date).ToString('s')
$report | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $backup 'report.json') -Encoding utf8
$report | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $build "install-desktop-plugins-$ts.report.json") -Encoding utf8

Say '--- summary ---'
foreach ($step in $report.steps) { Say ("  {0,-24} {1} {2}" -f $step.name, $(if ($step.ok) { 'PASS' } else { 'FAIL' }), $step.detail) }
Say "log: $log"
Say "report: $backup\report.json"
Write-Host ''
if ($failed) {
  Write-Host 'RESULT: NOT installed - the previous profile was restored and the app relaunched.' -ForegroundColor Yellow
  exit 2
}
Write-Host 'RESULT: plugins installed. Sidebar should show the stored sessions; skins/task-board/sidebar are back.' -ForegroundColor Green
exit 0
