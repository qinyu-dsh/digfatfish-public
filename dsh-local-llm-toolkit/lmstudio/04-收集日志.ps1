# ============================================================
#  04-收集日志.ps1  |  打包诊断材料，交给 DSH 排错
#  用法： powershell -ExecutionPolicy Bypass -File "04-收集日志.ps1"
#  产物： 桌面上的 LMStudio-诊断-<时间>.zip
#  安全： 自动抹掉配置里的 token / 密钥，不收 credentials 目录和聊天记录
# ============================================================
param(
  [string]$OutDir = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'SilentlyContinue'
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage   = Join-Path $env:TEMP "lmsdiag-$stamp"
$null    = New-Item -ItemType Directory -Path $stage -Force

function Say($m, $c = 'Gray') { Write-Host "  $m" -ForegroundColor $c }
function Save($name, [scriptblock]$sb) { & $sb 2>&1 | Out-String -Width 220 | Set-Content -Path (Join-Path $stage $name) -Encoding UTF8 }

Write-Host "正在收集诊断信息..." -ForegroundColor Cyan

# ---- A. 主日志 ----
$appLog = Join-Path $env:APPDATA 'LM Studio\logs\main.log'
if (Test-Path $appLog) {
  try { Copy-Item $appLog (Join-Path $stage 'main.log') -Force; Say "main.log 已收集" 'Green' }
  catch { Get-Content $appLog -Raw | Set-Content (Join-Path $stage 'main.log') -Encoding UTF8; Say "main.log 已收集(解锁复制)" 'Green' }
} else { Say "无 main.log" 'Yellow' }

# ---- B. 服务器请求日志 ----
$srv = Join-Path $env:USERPROFILE '.lmstudio\server-logs'
if (Test-Path $srv) {
  $files = Get-ChildItem $srv -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 20
  if ($files) {
    $d = Join-Path $stage 'server-logs'; $null = New-Item -ItemType Directory -Path $d -Force
    $files | ForEach-Object { Copy-Item $_.FullName $d -Force }
    Say "server-logs 收集 $($files.Count) 个文件" 'Green'
  } else { Say "server-logs 为空(正常：还没调用过 API)" 'DarkGray' }
}

# ---- C. 配置文件（自动脱敏） ----
$cfg = Join-Path $stage 'config'; $null = New-Item -ItemType Directory -Path $cfg -Force
$redact = {
  param($text)
  $text -replace '(?i)"(hfSearchToken|hfDownloadToken|hfToken|apiKey|api_key|accessToken|refreshToken|token)"\s*:\s*"[^"]*"', '"$1": "***REDACTED***"'
}
$settings = Join-Path $env:USERPROFILE '.lmstudio\settings.json'
# 注意：PowerShell 5.1 默认按 GBK 读文件，必须显式 -Encoding UTF8，否则中文路径会乱码
if (Test-Path $settings) { (& $redact (Get-Content $settings -Raw -Encoding UTF8)) | Set-Content (Join-Path $cfg 'settings.redacted.json') -Encoding UTF8; Say "settings.json 已收集并脱敏" 'Green' }

$internalWanted = @('backend-preferences-v1.json','http-server.json','download-jobs-info.json','app-install-location.json','conversation-config.json')
foreach ($n in $internalWanted) {
  $p = Join-Path $env:USERPROFILE ".lmstudio\.internal\$n"
  if (Test-Path $p) { Copy-Item $p (Join-Path $cfg $n) -Force }
}
# credentials 目录、聊天记录、预测历史：故意不收集（含隐私）

# ---- D. 硬件与运行时 ----
Save 'gpu.txt'      { nvidia-smi }
Save 'sysinfo.txt'  {
  "时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')  时区: $((Get-TimeZone).Id)"
  "系统: $((Get-CimInstance Win32_OperatingSystem).Caption)  Build $((Get-CimInstance Win32_OperatingSystem).BuildNumber)"
  $cs = Get-CimInstance Win32_ComputerSystem; $cpu = Get-CimInstance Win32_Processor
  "机型: $($cs.Manufacturer) $($cs.Model)"
  "CPU : $($cpu.Name) ($($cpu.NumberOfCores)核/$($cpu.NumberOfLogicalProcessors)线程)"
  "内存: $([math]::Round($cs.TotalPhysicalMemory/1GB,1)) GB"
  Get-PSDrive -PSProvider FileSystem | Where-Object Free | ForEach-Object { "磁盘 $($_.Name): 剩余 $([math]::Round($_.Free/1GB,1)) / 共 $([math]::Round(($_.Used+$_.Free)/1GB,1)) GB" }
}
$exe = 'E:\0001bendiAI\LM Studio\LM Studio.exe'
Save 'app.txt' {
  if (Test-Path $exe) { "程序: $exe"; "版本: $((Get-Item $exe).VersionInfo.FileVersion)"; "安装时间: $((Get-Item $exe).LastWriteTime)" }
  "LM Studio 进程:"; Get-Process 'LM Studio' | Select-Object Id, @{n='内存MB';e={[math]::Round($_.WorkingSet64/1MB)}}, StartTime | Format-Table -AutoSize | Out-String
}

# ---- E. 模型与服务器状态 ----
$lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
if (Test-Path $lms) {
  Save 'lms-ls.txt'         { & $lms ls }
  Save 'lms-ps.txt'         { & $lms ps }
  Save 'lms-server.txt'     { & $lms server status }
  Save 'lms-runtime.txt'    { & $lms runtime ls }
  Save 'lms-version.txt'    { & $lms --version; & $lms version }
}

# lms CLI 被管道捕获时不输出任何内容，所以服务器状态改用 HTTP 探测
Save 'server-probe.txt' {
  $h = Join-Path $env:USERPROFILE '.lmstudio\.internal\http-server.json'
  if (Test-Path $h) { "内部 IPC 服务: " + (Get-Content $h -Raw) }
  try {
    $r = Invoke-RestMethod 'http://127.0.0.1:1234/v1/models' -TimeoutSec 5
    "对外 API 端口 1234 正常，已加载模型:"
    $r.data | ForEach-Object { "  - $($_.id)" }
  } catch { "对外 API 端口 1234 无响应（服务器未开，属正常）" }
}
Save 'models-disk.txt' {
  $root = Join-Path $env:USERPROFILE '.lmstudio\models'
  Get-ChildItem $root -Recurse -File | Select-Object FullName, @{n='GB';e={[math]::Round($_.Length/1GB,2)}}, LastWriteTime | Format-Table -AutoSize | Out-String -Width 220
}
Save 'network.txt' {
  foreach ($t in @('huggingface.co','hf-mirror.com','www.modelscope.cn','lmstudio.ai')) {
    "$t : $((Test-NetConnection -ComputerName $t -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue))"
  }
}

# ---- F. 崩溃转储清单（只列文件名，不收大文件） ----
Save 'crashpad-list.txt' {
  Get-ChildItem (Join-Path $env:APPDATA 'LM Studio\Crashpad') -Recurse -File | Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize | Out-String
}

# ---- G. 打包 ----
$zip = Join-Path $OutDir "LMStudio-诊断-$stamp.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force

Write-Host ""
Write-Host "打包完成：" -ForegroundColor Green
Write-Host "  $zip" -ForegroundColor Yellow
Write-Host ("  大小 {0} KB" -f [math]::Round((Get-Item $zip).Length/1KB,1))
Write-Host ""
Write-Host "把这个 zip 发给 DSH 即可（已自动脱敏，不含聊天记录和账号凭据）。" -ForegroundColor Cyan
Write-Host "想省事先看结论：直接跑 02-一键体检.ps1。" -ForegroundColor DarkGray
