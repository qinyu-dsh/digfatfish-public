# restore-sessions.ps1 - 把降级时"改名丢下"的会话搬回权威库并安全重启（2026-09-21）
#
# 背景（见 DSH调试经验.md 第二十七/二十八节）：核心从 0.1.5-rc.1 回退到 0.1.1-rc.2 时，
# 新版 schema 的 sessions.sqlite 被改名为 sessions-from-new-core-*.sqlite，旧核新建空库，
# 于是 9-12 ~ 9-21 的会话在 GUI 里全部消失。本脚本把指定会话整段搬回。
#
# 只能作为计划任务运行：脚本第 1 步就杀 3080 服务，而排定它的 agent 回合就跑在那个进程里。
#   schtasks /Create /F /SC ONCE /ST <HH:mm> /TN DSH Restore Sessions /TR "restore-sessions-scheduled.cmd"
#
# 流程：杀服务(验证真死) -> 备份库与索引 -> Node 迁移 -> Node 修索引 -> 清探针锁 -> 起服务 -> HTTP 200
#      任一步失败 -> 覆盖回备份 -> 再起服务 -> 重新校验
param(
    [string]$Profile = 'web',
    [string]$SourceDb = '',
    [string]$Ids = '',
    [bool]$AddToWorkspace = $true,
    [string]$TaskName = 'DSH Restore Sessions',
    [switch]$DryRun
)
$ErrorActionPreference = 'Continue'
$tools   = $PSScriptRoot
$log     = Join-Path $tools 'restore-sessions.log'
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$liveDb  = Join-Path $dshHome 'sessions\sessions.sqlite'
$stamp   = Get-Date -Format 'yyyyMMddHHmmss'

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}
function Test-PortListening([int]$Port) {
    try { return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) } catch { return $false }
}
function Resolve-NodeExe {
    foreach ($p in @('D:\dsh\node\node.exe', 'D:\dsh\node.exe')) { if (Test-Path $p) { return $p } }
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}
function Resolve-DshBin {
    $p = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (Test-Path $p) { return $p }
    return $null
}
function Stop-DshServer {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bin\.js' -and $_.CommandLine -match '\bweb\b' }
    foreach ($p in $procs) {
        Write-Log "kill pid=$($p.ProcessId)"
        taskkill /PID $p.ProcessId /T /F 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 2
    $alive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bin\.js' -and $_.CommandLine -match '\bweb\b' }
    foreach ($p in $alive) {   # 火绒会静默拦截 taskkill（教训 3）
        Write-Log "taskkill 未生效，改用 Stop-Process pid=$($p.ProcessId)"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    $still = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bin\.js' -and $_.CommandLine -match '\bweb\b' }
    if ($still) { Write-Log "FATAL: 旧服务仍存活，中止（不迁移，避免双写）"; return $false }
    Write-Log '旧服务已确认停止'
    return $true
}
function Clear-TaskBoardLock {
    $lock = Join-Path $dshHome 'task-board\ledger-v2.lock'
    if (-not (Test-Path $lock)) { return }
    try { $j = Get-Content $lock -Raw | ConvertFrom-Json } catch { Remove-Item $lock -Force; Write-Log 'ledger 锁不可读 -> 删除'; return }
    $owner = $j.ownerPid
    if (-not $owner) { Remove-Item $lock -Force; Write-Log 'ledger 锁无 owner -> 删除'; return }
    if (-not (Get-Process -Id $owner -ErrorAction SilentlyContinue)) { Remove-Item $lock -Force; Write-Log "ledger 锁 owner=$owner 已死 -> 删除" }
    else { Write-Log "ledger 锁 owner=$owner 活着 -> 保留" }
}
function Start-DshServer {
    # 优先走桌面链路的 start-server.ps1（第二十六节修过 node 解析，自带 --no-open 与统一日志）
    $ss = 'D:\dhs01\dsh-desktop\start-server.ps1'
    if (Test-Path $ss) {
        # 不能加 -Wait：PowerShell 的 -Wait 会连后代一起等，而 start-server.ps1 派生的是常驻
        # node 服务 → 永不返回（2026-09-21 实测踩坑，末段日志与自删任务都没跑到）。改成轮询端口。
        $p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$ss -WindowStyle Hidden -PassThru
        for ($i = 0; $i -lt 70; $i++) { Start-Sleep -Seconds 1; if (Test-PortListening 3080) { break } }
        Write-Log "start-server.ps1 已派生 pid=$($p.Id)；3080 监听=$(Test-PortListening 3080)"
        if (Test-PortListening 3080) { return $true }
        Write-Log 'start-server.ps1 未直接成功，改用显式 node+bin 兜底'
    }
    $node = Resolve-NodeExe; $bin = Resolve-DshBin
    if (-not $node -or -not $bin) { Write-Log 'FATAL: 找不到 node 或 bin.js'; return $false }
    $serverCmd = "& '" + $node + "' '" + $bin + "' web --no-open"
    $logFile = 'D:\dhs01\dsh-desktop\dsh-server.log'
    $bootstrap = $serverCmd + ' *>> ' + $logFile
    Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command',$bootstrap -WindowStyle Hidden -WorkingDirectory $tools | Out-Null
    Write-Log "已兜底启动: node=$node bin=$bin"
    return $true
}
function Wait-Http200([int]$TimeoutSec = 75) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Seconds 3
    }
    return $false
}
function Backup-State([string]$tag) {
    $dir = Join-Path $tools ('backup-' + $tag)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    foreach ($f in @($liveDb, "$liveDb-wal", "$liveDb-shm")) {
        if (Test-Path $f) { Copy-Item $f (Join-Path $dir (Split-Path $f -Leaf)) -Force }
    }
    foreach ($f in @((Join-Path $dshHome 'storages\workspace.json'), (Join-Path $dshHome 'storages\session_projcache.json'))) {
        if (Test-Path $f) { Copy-Item $f (Join-Path $dir (Split-Path $f -Leaf)) -Force }
    }
    Write-Log "备份 -> $dir"
    return $dir
}
function Restore-State([string]$dir) {
    Remove-Item "$liveDb-wal", "$liveDb-shm" -Force -ErrorAction SilentlyContinue
    foreach ($n in @('sessions.sqlite', 'workspace.json', 'session_projcache.json')) {
        $src = Join-Path $dir $n
        if (-not (Test-Path $src)) { continue }
        if ($n -eq 'sessions.sqlite') { Copy-Item $src $liveDb -Force }
        else { Copy-Item $src (Join-Path $dshHome ('storages\' + $n)) -Force }
    }
    Write-Log '已从备份覆盖回原状'
}

Write-Log "===== restore-sessions 开始 (Profile=$Profile DryRun=$DryRun) ====="
$node = Resolve-NodeExe
if (-not $node) { Write-Log 'FATAL: 找不到 node.exe'; exit 1 }

if (-not $SourceDb) {
    foreach ($cand in @('sessions-backup-before-fix.sqlite', 'sessions-from-new-core-20260921-203706.sqlite')) {
        $p = Join-Path $dshHome ('sessions\' + $cand)
        if (Test-Path $p) { $SourceDb = $p; break }
    }
}
if (-not $SourceDb -or -not (Test-Path $SourceDb)) { Write-Log 'FATAL: 找不到源库'; exit 1 }
if (-not $Ids) {
    $idFile = Join-Path $tools 'restore-sessions-ids.txt'
    if (Test-Path $idFile) { $Ids = ((Get-Content $idFile) -join ',').Trim() }
}
if (-not $Ids) { Write-Log 'FATAL: 没有指定会话 id'; exit 1 }
Write-Log "源库: $SourceDb"
Write-Log "会话: $Ids"

if ($DryRun) {
    $copy = Join-Path $env:TEMP ('restore-dryrun-' + $stamp + '.sqlite')
    Copy-Item $liveDb $copy -Force
    foreach ($sfx in @('-wal', '-shm')) { if (Test-Path "$liveDb$sfx") { Copy-Item "$liveDb$sfx" "$copy$sfx" -Force } }
    & $node (Join-Path $tools 'restore-sessions.cjs') --from $SourceDb --to $copy --ids $Ids
    Write-Log "DryRun 结束，副本在 $copy（真库未动）"
    exit 0
}

if (-not (Stop-DshServer)) { exit 1 }
$bak = Backup-State $stamp
$ok = $false
try {
    & $node (Join-Path $tools 'restore-sessions.cjs') --from $SourceDb --to $liveDb --ids $Ids
    if ($LASTEXITCODE -ne 0) { throw "迁移脚本退出码 $LASTEXITCODE" }
    if ($AddToWorkspace) {
        & $node (Join-Path $tools 'restore-sessions-index.cjs') --ids $Ids
    }
    $ok = $true
} catch {
    Write-Log "迁移失败: $_"
    Restore-State $bak
}
Clear-TaskBoardLock
Start-DshServer | Out-Null
if (Wait-Http200 75) {
    Write-Log "HTTP 200 OK  (迁移成功=$ok)"
} elseif ($ok) {
    Write-Log '起服务后未拿到 200 -> 回滚备份再试'
    Stop-DshServer | Out-Null
    Restore-State $bak
    Clear-TaskBoardLock
    Start-DshServer | Out-Null
    if (Wait-Http200 75) { Write-Log '回滚后 HTTP 200 OK（数据未恢复，服务已救回）' }
    else { Write-Log 'FATAL: 回滚后仍无法起来，需要人工介入（dsh-server.log / restore-server.err.log）' }
} else {
    Write-Log 'FATAL: 服务未起来且迁移也未成功，请查 restore-server.err.log'
}
Write-Log '===== restore-sessions 结束 ====='
if ($TaskName) { & 'C:\Windows\System32\schtasks.exe' /Delete /TN $TaskName /F 2>&1 | Out-Null; Write-Log "已自删计划任务 $TaskName" }
