# ============================================================
#  02-一键体检.ps1  |  LM Studio + 硬件 + 网络 体检
#  用法： powershell -ExecutionPolicy Bypass -File "02-一键体检.ps1"
# ============================================================
$ErrorActionPreference = 'SilentlyContinue'
$lms     = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
$appLog  = Join-Path $env:APPDATA 'LM Studio\logs\main.log'
$srvLogs = Join-Path $env:USERPROFILE '.lmstudio\server-logs'

function Head($t) { Write-Host ""; Write-Host ("=" * 62) -ForegroundColor DarkCyan; Write-Host "  $t" -ForegroundColor Cyan; Write-Host ("=" * 62) -ForegroundColor DarkCyan }

Write-Host "LM Studio 体检报告   时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')" -ForegroundColor Yellow

Head "1. 显卡 / 驱动"
$smi = nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,driver_version --format=csv,noheader 2>&1
if ($smi) { $smi | ForEach-Object { write-host "  $_" } } else { Write-Host "  [!] 未检测到 nvidia-smi" -ForegroundColor Red }

Head "2. CPU / 内存 / 磁盘"
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor
Write-Host ("  CPU : {0} ({1}核/{2}线程)" -f $cpu.Name, $cpu.NumberOfCores, $cpu.NumberOfLogicalProcessors)
Write-Host ("  内存: {0} GB" -f [math]::Round($cs.TotalPhysicalMemory/1GB,1))
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -ne $null } |
  ForEach-Object { Write-Host ("  磁盘 {0}: 剩余 {1} GB / 共 {2} GB" -f $_.Name, [math]::Round($_.Free/1GB,1), [math]::Round(($_.Used+$_.Free)/1GB,1)) }

Head "3. LM Studio 版本 / 推理后端"
$exe = 'E:\0001bendiAI\LM Studio\LM Studio.exe'
if (Test-Path $exe) {
  $v = (Get-Item $exe).VersionInfo.FileVersion
  Write-Host "  程序: $exe  (版本 $v)"
  Write-Host "  进程: $((Get-Process 'LM Studio').Count) 个在运行"
} else { Write-Host "  [!] 未找到: $exe" -ForegroundColor Red }
$pref = Join-Path $env:USERPROFILE '.lmstudio\.internal\backend-preferences-v1.json'
if (Test-Path $pref) {
  (Get-Content $pref -Raw | ConvertFrom-Json) | ForEach-Object { Write-Host ("  后端: {0} (v{1}) 格式 {2}" -f $_.name, $_.version, $_.model_format) }
} else { Write-Host "  [!] 无后端偏好文件（可能后端未安装）" -ForegroundColor Red }

Head "4. 模型目录与已下载的模型"
$setFile = Join-Path $env:USERPROFILE '.lmstudio\settings.json'
$mdir = Join-Path $env:USERPROFILE '.lmstudio\models'
if (Test-Path $setFile) {
  # 必须显式 -Encoding UTF8，否则 PS 5.1 按 GBK 读会把中文用户名读坏
  $df = (Get-Content $setFile -Raw -Encoding UTF8 | ConvertFrom-Json).downloadsFolder
  if ($df) { $mdir = $df }
}
Write-Host "  模型目录: $mdir"
if (Test-Path $mdir) {
  $drv = ($mdir -split ':')[0]
  $freeGB = [math]::Round((Get-PSDrive $drv -ErrorAction SilentlyContinue).Free / 1GB, 1)
  $usedGB = [math]::Round((Get-ChildItem $mdir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Sum Length).Sum / 1GB, 2)
  Write-Host ("  所在盘 {0}: 剩余 {1} GB    模型共占 {2} GB" -f $drv, $freeGB, $usedGB)
  if ($freeGB -lt 15) { Write-Host "  [!] 所在盘剩余不足 15GB，建议换到空间大的盘（见教程 §2）" -ForegroundColor Red }
} else { Write-Host "  [!] 目录不存在：$mdir" -ForegroundColor Red }
if (Test-Path $lms) { & $lms ls 2>&1 | ForEach-Object { Write-Host "  $_" } } else { Write-Host "  [!] 未找到 lms.exe" -ForegroundColor Red }

Head "5. 本地服务器状态"
& $lms server status 2>&1 | ForEach-Object { Write-Host "  $_" }
try {
  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:1234/v1/models' -TimeoutSec 5
  Write-Host "  端口 1234 API 正常，已加载模型:" -ForegroundColor Green
  $r.data | ForEach-Object { Write-Host "    - $($_.id)" }
} catch { Write-Host "  端口 1234 无响应（服务器未开，属正常）" -ForegroundColor DarkGray }

Head "6. 网络连通性（决定能不能下载模型）"
foreach ($t in @('huggingface.co','hf-mirror.com','www.modelscope.cn','lmstudio.ai')) {
  $ok = Test-NetConnection -ComputerName $t -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue
  $mark = if ($ok) { '通' } else { '不通' }
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("  {0,-20} {1}" -f $t, $mark) -ForegroundColor $color
}

Head "7. 主日志尾部（最近 25 行）"
if (Test-Path $appLog) {
  Write-Host "  文件: $appLog"
  Write-Host ("  大小: {0} KB   行数: {1}" -f [math]::Round((Get-Item $appLog).Length/1KB,1), (Get-Content $appLog).Count)
  Get-Content $appLog -Tail 25 | ForEach-Object { Write-Host "  | $_" -ForegroundColor DarkGray }
} else { Write-Host "  [!] 无主日志" -ForegroundColor Red }

Head "8. 服务器请求日志目录"
if (Test-Path $srvLogs) {
  $f = Get-ChildItem $srvLogs -Recurse
  if ($f) { $f | Select-Object -Last 10 | ForEach-Object { Write-Host "  $($_.FullName)  ($([math]::Round($_.Length/1KB,1)) KB)" } }
  else { Write-Host "  $srvLogs  (空 —— 还没调用过 API，正常)" }
} else { Write-Host "  [!] 目录不存在: $srvLogs" -ForegroundColor Red }

Write-Host ""
Write-Host "体检结束。想让我排错，就再跑一次 04-收集日志.ps1 把 zip 发我。" -ForegroundColor Yellow
