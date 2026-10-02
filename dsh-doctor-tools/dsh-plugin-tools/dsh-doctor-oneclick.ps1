# dsh-doctor-oneclick.ps1 - one-click emergency recovery for the DSH web server.
# Double-click "DSH 医生急救" on the desktop (or run manually):
#   1. probe the CURRENT config on a spare port;
#      - probe PASS  -> config is fine, do a safe restart (restart-dsh.ps1);
#      - probe FAIL  -> config is broken, roll back to the last healthy
#                       snapshot first (dsh-rollback.ps1 -Auto), then restart;
#   2. verify real HTTP 200 on a NEW pid and report.
# A visible console window stays open so the result can be read.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File dsh-doctor-oneclick.ps1

. "$PSScriptRoot\watchdog-common.ps1"

$restartScript = Join-Path $PSScriptRoot 'restart-dsh.ps1'
$rollbackScript = Join-Path $PSScriptRoot 'dsh-rollback.ps1'

function Show-Header {
    Write-Host ''
    Write-Host '============================================'
    Write-Host '   DSH 医生急救 (one-click recovery)'
    Write-Host '============================================'
    Write-Host ("now: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
}

function Show-Verdict([int]$Code) {
    Write-Host ''
    Write-Host '--------------------------------------------'
    if ($Code -eq 0) {
        Write-Host '  ✅ 服务已恢复正常，可以继续使用了。' -ForegroundColor Green
    } else {
        Write-Host '  ❌ 急救未完全成功，请查看上面的输出。' -ForegroundColor Red
        Write-Host '     排查材料：D:\dhs01\dsh-desktop\dsh-server.log'
        Write-Host '              D:\dhs01\dsh-plugin-tools\watchdog.log'
    }
    Write-Host '--------------------------------------------'
    Write-Host '窗口即将关闭...' -NoNewline
    Start-Sleep -Seconds 8
}

Show-Header

# --- 0) quick status ------------------------------------------------
$healthyNow = Test-ServerHealthy
$pidNow = Get-ServerPid
$state = Get-WdState

if ($healthyNow) {
    Write-Host ("服务当前是正常的 (pid=$pidNow, HTTP 200)")
    Write-Host ("健康锚点: " + $state.lastHealthySnapshot)
    Write-Host '无需急救。若你只是想重启服务（比如刚装完插件），请改用 restart-dsh.ps1。'
    Show-Verdict 0
    exit 0
}

Write-Host ("服务不可用 (pid=$pidNow) - 开始急救流程...") -ForegroundColor Yellow
Write-Host ''

# --- 1) is the CURRENT config bootable? ------------------------------
Write-Host '--- 步骤1: 探测当前配置能否启动 ---'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restartScript -ProbeOnly 2>&1 | ForEach-Object { Write-Host $_ }
$probeExit = $LASTEXITCODE
Write-Host ''

if ($probeExit -eq 0) {
    # --- 2a) config is fine: safe restart only -------------------------
    Write-Host '--- 步骤2: 配置正常，执行安全重启 ---'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restartScript 2>&1 | ForEach-Object { Write-Host $_ }
} else {
    # --- 2b) config is broken: roll back first -------------------------
    Write-Host '--- 步骤2: 配置已损坏，回滚到最近健康快照 ---' -ForegroundColor Yellow
    if ($state.lastHealthySnapshot) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $rollbackScript -Auto 2>&1 | ForEach-Object { Write-Host $_ }
        $rbExit = $LASTEXITCODE
        if ($rbExit -ne 0 -and $rbExit -ne 3) {
            Show-Verdict 1
            exit 1
        }
        # rollback exit 0 = restarted OK; exit 3 = restored but not up -> try one plain restart
        if ($rbExit -eq 3) {
            Write-Host '--- 补充: 回滚完成但服务未起，再试一次安全重启 ---'
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restartScript 2>&1 | ForEach-Object { Write-Host $_ }
        }
    } else {
        Write-Host '没有任何健康快照可回滚 - 只能尝试直接重启 (风险: 可能仍会崩)' -ForegroundColor Red
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restartScript 2>&1 | ForEach-Object { Write-Host $_ }
    }
}

# --- 3) final verification -------------------------------------------
Write-Host '--- 步骤3: 验证服务是否真正恢复 ---'
$ok = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    $c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
        try {
            $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { $ok = $true; break }
        } catch { }
    }
}
$newPid = Get-ServerPid
if ($ok) {
    Write-Host ("✅ 服务已恢复: pid=$newPid (HTTP 200)") -ForegroundColor Green
    Write-WdEvent 'INFO' "doctor one-click: recovery OK, server pid=$newPid"
    Show-Verdict 0
    exit 0
} else {
    Write-Host '❌ 服务仍未恢复 - 请看 dsh-server.log 排查' -ForegroundColor Red
    Get-Content 'D:\dhs01\dsh-desktop\dsh-server.log' -Tail 15 -Encoding UTF8 | ForEach-Object { Write-Host $_ }
    Write-WdEvent 'ERROR' 'doctor one-click: recovery FAILED - server did not come up'
    Show-Verdict 1
    exit 1
}
