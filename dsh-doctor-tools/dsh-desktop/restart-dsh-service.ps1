# restart-dsh-service.ps1 - stop the 3080 service (verified dead) and start it again via the
# hardened launcher, then verify HTTP + plugin health.  Written 2026-09-23 for the
# "GUI plugin update" flow: the update only rewrites files, so a restart is needed to load them.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File restart-dsh-service.ps1
$ErrorActionPreference = 'Continue'
function Test-Port([int]$p) { return $null -ne (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }
function Test-Alive([string]$base) {
  foreach ($u in @($base + 'api/plugin-manager/failures', $base)) {
    try { $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -lt 500) { return $true } } catch { if ($_.Exception.Response) { return $true } }
  }
  return $false
}
$log = 'D:\dhs01\dsh-plugin-tools\restart-dsh-service.log'
function Say([string]$m) { $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m; Add-Content -Path $log -Value $line -Encoding utf8; Write-Output $line }

Say '=== restart requested ==='
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  $pid3080 = [int]$conn.OwningProcess
  Say ("stopping pid " + $pid3080)
  Stop-Process -Id $pid3080 -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if (-not (Test-Port 3080)) { break } }
  if (Test-Port 3080) { Say 'STOP FAILED - port still listening'; exit 1 }
  Say 'port released'
} else { Say 'nothing listening - starting fresh' }

Say 'starting via start-server.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\dhs01\dsh-desktop\start-server.ps1' | Out-Null
for ($i = 0; $i -lt 90; $i++) { Start-Sleep -Seconds 1; if (Test-Port 3080) { break } }
if (-not (Test-Port 3080)) { Say 'START FAILED - nothing listening after 90s'; exit 1 }

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Alive 'http://127.0.0.1:3080/') { break }
}
$ok = Test-Alive 'http://127.0.0.1:3080/'
$pidNow = (Get-NetTCPConnection -LocalPort 3080 -State Listen | Select-Object -First 1).OwningProcess
Say ("server pid " + $pidNow + " | alive=" + $ok)
try {
  $f = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/api/plugin-manager/failures' -UseBasicParsing -TimeoutSec 8
  Say ('failures: ' + $f.Content)
} catch { Say 'failures endpoint unreachable' }
if ($ok) { Say 'RESULT: PASS' } else { Say 'RESULT: FAIL' }
