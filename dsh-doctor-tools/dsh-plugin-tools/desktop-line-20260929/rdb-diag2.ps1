#requires -Version 7
<#
  rdb-diag2.ps1 — A/B test for the 2026-09-29 "session-rdb failed to import" probe failure.

  A: install the 6-package set into an isolated scratch profile and boot THAT profile directly.
  B: boot a second profile whose node_modules is a JUNCTION to A's tree — exactly what
     install-desktop-plugins.ps1 does for its rehearsal.

  If A is green and B is red, the junction (not the plugin set) is what breaks the probe, and the
  real app — which runs on its own profile without a junction — was never actually broken.

  Nothing here touches the real home, the running app, or port 19387.
  Usage: pwsh -NoProfile -File rdb-diag2.ps1
#>
param(
  [string]$Root = ('E:\deepseek\_build\rdb-ab-' + (Get-Date -Format 'yyyyMMdd-HHmmss')),
  [int]$PortA = 19421,
  [int]$PortB = 19422,
  [string]$RealHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$Snapshot = 'D:\dhs01\backups\desktop-plugins-20260929-222408\sessions.sqlite.snapshot'
)

$ErrorActionPreference = 'Continue'
$appExe  = 'E:\deepseek\DSH\DeepSeek Harness.exe'
$cliCmd  = 'E:\deepseek\DSH\resources\runtime\cli\bin\dsh.cmd'
$nodeExe = 'D:\dsh\node\node.exe'
$build   = 'E:\deepseek\_build'
$log     = Join-Path $build 'rdb-ab.log'
$packages = @(
  '@linxin666/dsh-web-all@0.4.4',
  'dsh-better-sidebar@0.24.1',
  '@liustack/modlens@3.26.5',
  'dsh-meme@0.1.44',
  'dsh-routing-suite@0.1.2',
  '@morlay/better-session@0.1.3'
)
$bundleOrder = @(
  '@linxin666/dsh-web-all',
  '@liustack/modlens',
  'dsh-meme',
  'dsh-routing-suite',
  'dsh-better-sidebar',
  '@morlay/better-session'
)

function Say {
  param([string]$Message, [string]$Level = 'INFO')
  $line = '[{0}] {1,-4} {2}' -f (Get-Date -Format 'HH:mm:ss'), $Level, $Message
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding utf8
}
function Test-Port { param([int]$Port) [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) }

function Invoke-Boot {
  param([string]$ProfileName, [int]$Port, [string]$Tag, [string]$ScratchHome)
  $outFile = Join-Path $Root ("boot-$Tag.out")
  $errFile = Join-Path $Root ("boot-$Tag.err")
  if (Test-Port $Port) { Say ("port {0} busy - skipping {1}" -f $Port, $Tag) 'FAIL'; return }
  $env:DSH_HOME = $ScratchHome
  Say ("[$Tag] booting profile {0} on {1} (DSH_HOME={2})" -f $ProfileName, $Port, $ScratchHome)
  $proc = Start-Process -FilePath $cliCmd -ArgumentList '--profile', $ProfileName, '--no-open', '--port', "$Port" `
    -RedirectStandardOutput $outFile -RedirectStandardError $errFile -WindowStyle Hidden -PassThru
  $listening = $false
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Port $Port) { $listening = $true; break }
    if ($proc.HasExited) { break }
  }
  Start-Sleep -Seconds 4
  $errText = [string](Get-Content $errFile -Raw -ErrorAction SilentlyContinue)
  $outText = [string](Get-Content $outFile -Raw -ErrorAction SilentlyContinue)
  $owner = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
  if ($owner) { & taskkill /PID $owner /T /F 2>&1 | Out-Null }
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 20; $i++) { if (-not (Test-Port $Port)) { break }; Start-Sleep -Seconds 1 }

  Say ("[$Tag] listening={0}  portFreeAfter={1}" -f $listening, (-not (Test-Port $Port))) $(if ($listening) { 'OK' } else { 'FAIL' })
  $lines = @($errText -split "`n" | Where-Object { $_.Trim() })
  foreach ($line in $lines) { Write-Host "    [$Tag] $line"; Add-Content -Path $log -Value "    [$Tag] $line" -Encoding utf8 }
  $sessionRdbBad = $errText -match 'session-rdb.*failed to import'
  $notActivated = ([regex]::Match($errText, 'warning: (\d+) entr')).Groups[1].Value
  Say ("[$Tag] RESULT: notActivated={0}  sessionRdbFailedToImport={1}" -f ($notActivated ? $notActivated : '0'), $sessionRdbBad) $(if ($sessionRdbBad) { 'FAIL' } else { 'OK' })
  return [pscustomobject]@{ Tag = $Tag; Listening = $listening; NotActivated = $notActivated; SessionRdbFailed = $sessionRdbBad }
}

$scratchHome = Join-Path $Root 'home'
$profileDir  = Join-Path $scratchHome 'profiles\desktop-diag'
$juncDir     = Join-Path $scratchHome 'profiles\desktop-junc'
New-Item -ItemType Directory -Force -Path $profileDir, $juncDir, (Join-Path $scratchHome 'sessions') | Out-Null
Say ("scratch root : {0}" -f $Root)
Say ("scratch home : {0}" -f $scratchHome)

# scratch home contents
foreach ($extra in @('.credentials.yaml', 'pet.json', 'dsh-expression.json')) {
  $src = Join-Path $RealHome $extra
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $scratchHome $extra) -Force }
}
Copy-Item -LiteralPath (Join-Path $RealHome 'profiles\desktop\cordis.yml') (Join-Path $profileDir 'cordis.yml') -Force
Copy-Item -LiteralPath (Join-Path $RealHome 'profiles\desktop\cordis.patch.yml') (Join-Path $profileDir 'cordis.patch.yml') -Force
Copy-Item -LiteralPath $Snapshot (Join-Path $scratchHome 'sessions\sessions.sqlite') -Force
$manifest = [ordered]@{
  name = 'dsh-profile-desktop-diag'; private = $true; dependencies = [ordered]@{}
  dsh = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') } }
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $profileDir 'package.json') -Encoding utf8
# same pnpm gates as the real profile (nodeLinker/autoInstallPeers matter: peers must NOT be auto-installed)
@"
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
"@ | Set-Content -LiteralPath (Join-Path $profileDir 'pnpm-workspace.yaml') -Encoding utf8
& $nodeExe (Join-Path $build 'normalize-workspace.mjs') (Join-Path $profileDir 'pnpm-workspace.yaml') | Out-Null
Say 'scratch home ready'

# --- install -----------------------------------------------------------------------------------------
$env:DSH_HOME = $scratchHome
Say ("installing {0} packages from the registry" -f $packages.Count)
$out = & $cliCmd plugin --profile desktop-diag add @packages 2>&1
$rc = $LASTEXITCODE
$out | Add-Content -Path $log -Encoding utf8
$out | Where-Object { "$_" -match 'ERR_|progress|Progress|error' -eq $false } | Select-Object -Last 12 | ForEach-Object { Write-Host "    $_" }
Say ("install rc={0}" -f $rc) $(if ($rc -eq 0) { 'OK' } else { 'FAIL' })
& $nodeExe (Join-Path $build 'ensure-bundles.mjs') $profileDir @bundleOrder | Add-Content -Path $log -Encoding utf8

$nm = Join-Path $profileDir 'node_modules'
Say '--- what the registry install produced under node_modules/@deepseek-ai ---'
if (Test-Path (Join-Path $nm '@deepseek-ai')) {
  Get-ChildItem (Join-Path $nm '@deepseek-ai') | ForEach-Object {
    $v = (Get-Content (Join-Path $_.FullName 'package.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json).version
    Say ("    @deepseek-ai/{0}@{1}" -f $_.Name, $v)
  }
} else { Say '    (no @deepseek-ai dir)' }
foreach ($n in @('dsh-meme', 'dsh-better-sidebar', '@morlay\session-rdb', '@linxin666\dsh-web-all')) {
  if (Test-Path (Join-Path $nm $n)) { Say ("    present: {0}" -f $n) } else { Say ("    MISSING: {0}" -f $n) 'WARN' }
}

# --- direct import test in profile A -----------------------------------------------------------------
$importTest = Join-Path $profileDir '_diag-import.mjs'
@'
const targets = ['@morlay/session-rdb', '@morlay/better-session', '@deepseek-ai/schemastery', '@deepseek-ai/cosmokit', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence'];
for (const t of targets) {
  try { const m = await import(t); console.log(`OK   ${t} exports=${Object.keys(m).length}`); }
  catch (e) { console.log(`FAIL ${t} :: ${e && e.message ? e.message : String(e)}`); }
}
console.log('node=' + process.versions.node + ' electron=' + (process.versions.electron ?? 'n/a') + ' cwd=' + process.cwd());
'@ | Set-Content -LiteralPath $importTest -Encoding utf8
$env:ELECTRON_RUN_AS_NODE = '1'
Say '--- direct import test (Electron node, cwd = the profile) ---'
Push-Location $profileDir
$import = & $appExe $importTest 2>&1
Pop-Location
$import | ForEach-Object { Write-Host "    $_"; Add-Content -Path $log -Value "    $_" -Encoding utf8 }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# --- A: boot the installed profile directly -----------------------------------------------------------
$resA = Invoke-Boot -ProfileName 'desktop-diag' -Port $PortA -Tag 'A-direct' -ScratchHome $scratchHome

# --- B: boot a profile whose node_modules is a junction to A (what the installer does) ------------------
foreach ($name in @('package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml')) {
  Copy-Item -LiteralPath (Join-Path $profileDir $name) (Join-Path $juncDir $name) -Force
}
& cmd /c rmdir "$(Join-Path $juncDir 'node_modules')" 2>&1 | Out-Null
New-Item -ItemType Junction -Path (Join-Path $juncDir 'node_modules') -Target $nm | Out-Null
Say ("junction: {0} -> {1}" -f (Join-Path $juncDir 'node_modules'), $nm)
$resB = Invoke-Boot -ProfileName 'desktop-junc' -Port $PortB -Tag 'B-junction' -ScratchHome $scratchHome

# --- verdict -------------------------------------------------------------------------------------------
Say '=== verdict ==='
Say ("A (direct boot)   : listening={0} notActivated={1} sessionRdbFailed={2}" -f $resA.Listening, $resA.NotActivated, $resA.SessionRdbFailed)
Say ("B (junction boot) : listening={0} notActivated={1} sessionRdbFailed={2}" -f $resB.Listening, $resB.NotActivated, $resB.SessionRdbFailed)
if (-not $resA.SessionRdbFailed -and $resB.SessionRdbFailed) {
  Say 'CONCLUSION: the junction is what broke the probe; a directly-installed profile boots clean.' 'OK'
} elseif ($resA.SessionRdbFailed -and $resB.SessionRdbFailed) {
  Say 'CONCLUSION: the failure reproduces without any junction - it is in the plugin set itself.' 'FAIL'
} else {
  Say 'CONCLUSION: inconclusive from this run - read the logs above.' 'WARN'
}
Say ("artifacts: {0}" -f $Root)
