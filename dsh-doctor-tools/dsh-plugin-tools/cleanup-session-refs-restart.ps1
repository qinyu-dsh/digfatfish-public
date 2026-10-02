# cleanup-session-refs-restart.ps1
# One-shot: kill old dsh server -> clean stale session index refs -> start fresh.
# Order matters: the running server caches the session index in memory and
# periodically writes it back, so files must be cleaned only AFTER the old
# process is dead and BEFORE the new one boots.
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'cleanup-restart.log'
$storages = Join-Path $env:USERPROFILE '.dsh\storages'
$serverLog = 'D:\dhs01\dsh-desktop\dsh-server.log'

function Write-Log([string]$m) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"
    Add-Content -Path $log -Value $line -Encoding UTF8
    Write-Output $line
}

Write-Log '=== cleanup-session-refs restart start ==='

# 1) kill whatever listens on 3080 - and VERIFY it actually died
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
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
} else {
    Write-Log 'no server was listening on 3080'
}

# 2) clean stale session refs from storage index files (node, BOM-safe)
$js = @'
const fs = require('fs');
const dir = process.argv[2];
const del = [
  'session-32836e67-37d6-4f15-b7bc-a274a200d634',
  'session-1c00d10a-8882-4605-84c9-8127453ced36',
  'session-1118e7f6-3f58-49e5-90f6-05c2baccae43',
  'session-475f6ba2-be6d-44d0-b1cc-bff635817c4b'
];
for (const f of ['workspace.json', 'session_projcache.json']) {
  const fp = dir + '\\' + f;
  const raw = fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, '');
  const o = JSON.parse(raw);
  let changed = false;
  if (o.tables && o.tables.workspaces) {
    for (const wid of Object.keys(o.tables.workspaces)) {
      const ids = o.tables.workspaces[wid].sessionIds || [];
      const n = ids.filter(id => !del.includes(id));
      if (n.length !== ids.length) { o.tables.workspaces[wid].sessionIds = n; changed = true; }
    }
  }
  if (o.tables && o.tables.sessions) {
    for (const id of del) { if (o.tables.sessions[id]) { delete o.tables.sessions[id]; changed = true; } }
  }
  if (changed) fs.writeFileSync(fp, JSON.stringify(o, null, 2));
  console.log(f + ': ' + (changed ? 'cleaned' : 'clean'));
}
'@
$jsFile = Join-Path $env:TEMP ("cleanup-refs-" + [guid]::NewGuid().ToString('N') + ".cjs")
[System.IO.File]::WriteAllText($jsFile, $js, [System.Text.UTF8Encoding]::new($false))
node $jsFile $storages 2>&1 | ForEach-Object { Write-Log $_ }
Remove-Item $jsFile -Force -ErrorAction SilentlyContinue

# 3) start a fresh hidden server (same logic as the desktop launcher)
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
$serverCmd = if ($dshCmd) { 'dsh web --no-open' } else { 'npx --yes @deepseek-ai/dsh web --no-open' }
$bootstrap = "`$ErrorActionPreference='Continue'; " + $serverCmd + " *>> '" + $serverLog + "'"
Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $bootstrap `
    -WindowStyle Hidden -WorkingDirectory $PSScriptRoot | Out-Null
Write-Log "started new server: $serverCmd"

# 4) wait for real readiness (port listening + HTTP 200)
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

# 5) verdict - judged by the REAL start
$verdict = if ($httpOk) { 'PASS' } else { 'FAIL - new server did not come up; check dsh-server.log' }
Write-Log "verdict: $verdict"
Write-Log '=== cleanup-session-refs restart done ==='

# self-cleanup: remove the one-shot scheduled task that launched this script
schtasks /Query /FO CSV 2>$null | Select-String 'DSH.?Restart|DSHCleanup' | ForEach-Object {
    $n = ($_.Line -split ',')[0].Trim('"')
    schtasks /Delete /TN $n /F 2>$null | Out-Null
}
