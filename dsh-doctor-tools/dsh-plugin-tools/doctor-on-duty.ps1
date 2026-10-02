# doctor-on-duty.ps1  --  SCHEDULED TASK ONLY.
# Never run this synchronously from an agent session: the kill step would take down the caller's own process tree.
# Flow: stop "dsh web" -> purge GHOST sessions from projection caches -> start "dsh web" -> verify HTTP 200.
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$log  = Join-Path $root 'doctor-on-duty.log'
$port = 3080

function L($m) {
  $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding UTF8
}

'' | Add-Content -Path $log -Encoding UTF8
L ('===== doctor on duty: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' =====')

# 1) locate the running server
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$oldPid = 0
if ($conn) { $oldPid = [int]$conn.OwningProcess }
L ('old server pid = ' + $oldPid)

# 2) stop it, then VERIFY it is really gone (AV may silently block taskkill)
if ($oldPid -gt 0) {
  & taskkill /F /T /PID $oldPid 2>&1 | ForEach-Object { L ('taskkill> ' + $_) }
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 700
    if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { break }
  }
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
    L 'taskkill did not kill it -> fallback Stop-Process'
    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
    L 'ABORT: old server still alive after kill (AV block?). Nothing was cleaned.'
    exit 1
  }
  L 'old server stopped'
} else {
  L 'no listener on the port, nothing to stop'
}
Start-Sleep -Seconds 2

# 3) purge ghost sessions (helper writes its own backups before touching anything)
# node 路径自动探测（2026-09-16 起 node 被挪到 D:\dsh\node\，别再硬编码旧路径）
$node = 'D:\dsh\node\node.exe'
if (-not (Test-Path $node)) { $node = 'D:\dsh\node.exe' }
if (-not (Test-Path $node)) {
  $cand = Get-ChildItem 'D:\dsh' -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cand) { $node = $cand.FullName }
}
L ('node = ' + $node)
& $node (Join-Path $root 'doctor-on-duty.cjs') 2>&1 | ForEach-Object { L ('clean> ' + $_) }

# 4) start the server again (reuse the existing launcher)
$launcher = 'D:\dhs01\dsh-desktop\start-server.ps1'
if (Test-Path $launcher) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher | Out-Null
} else {
  L ('launcher missing: ' + $launcher)
}

# 5) verify: HTTP 200 on the same port
$ok = $false
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port) -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
$conn2 = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$newPid = 0
if ($conn2) { $newPid = [int]$conn2.OwningProcess }
L ('new server pid = ' + $newPid + '  http200=' + $ok)
if ($ok) { L 'RESULT: PASS (ghosts purged, server back up)' } else { L 'RESULT: FAIL (server not responding; see dsh-server.log)' }
