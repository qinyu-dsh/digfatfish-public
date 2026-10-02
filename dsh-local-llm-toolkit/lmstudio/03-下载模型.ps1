# ============================================================
#  03-下载模型.ps1  |  从 hf-mirror.com 镜像下载 GGUF 模型
#  用法：
#     powershell -ExecutionPolicy Bypass -File "03-下载模型.ps1"
#     powershell -ExecutionPolicy Bypass -File "03-下载模型.ps1" -CoreOnly
#     powershell -ExecutionPolicy Bypass -File "03-下载模型.ps1" -Only Coder
#     powershell -ExecutionPolicy Bypass -File "03-下载模型.ps1" -WithVL
#     powershell -ExecutionPolicy Bypass -File "03-下载模型.ps1" -Yes      # 无人值守
#  特点：断点续传（断了重跑即可）、自动放到 LM Studio 认的目录、下载完校验大小
# ============================================================
param(
  [switch]$CoreOnly,   # 只下前两个核心模型（跳过编程模型）
  [switch]$WithVL,     # 额外下载 Qwen2.5-VL 视觉模型（图片型 PDF 用）
  [switch]$Yes,        # 无人值守：不按回车直接开始（给脚本/自动化用）
  [string]$Only        # 只下名字里包含该关键字的模型，如 -Only Coder
)

$ErrorActionPreference = 'Stop'

# ---- 1. 找到 LM Studio 的模型目录 ----
$settings = Join-Path $env:USERPROFILE '.lmstudio\settings.json'
$modelsRoot = Join-Path $env:USERPROFILE '.lmstudio\models'
if (Test-Path $settings) {
  # 注意：PowerShell 5.1 默认按 GBK 读文件，会把中文用户名读坏，必须显式指定 UTF8
  $folder = (Get-Content $settings -Raw -Encoding UTF8 | ConvertFrom-Json).downloadsFolder
  if ($folder) { $modelsRoot = $folder }
}
Write-Host "模型目录: $modelsRoot" -ForegroundColor Cyan
if (-not (Test-Path $modelsRoot)) { New-Item -ItemType Directory -Path $modelsRoot -Force | Out-Null }

# ---- 2. 模型清单（作者 / 仓库 / 文件名 / 预期大小GB） ----
$models = @(
  [pscustomobject]@{ Key='Qwen25-7B';  Author='lmstudio-community'; Repo='Qwen2.5-7B-Instruct-GGUF';        File='Qwen2.5-7B-Instruct-Q4_K_M.gguf';        SizeGB=4.36; Desc='通用主力（总结/翻译/问答）' }
  [pscustomobject]@{ Key='HunyuanMT';  Author='mradermacher';       Repo='Hunyuan-MT-7B-GGUF';              File='Hunyuan-MT-7B.Q4_K_M.gguf';              SizeGB=4.31; Desc='专业翻译（33语种）' }
  [pscustomobject]@{ Key='Coder';      Author='lmstudio-community'; Repo='Qwen2.5-Coder-7B-Instruct-GGUF';  File='Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf';  SizeGB=4.36; Desc='编程辅助' }
  [pscustomobject]@{ Key='VL3B';       Author='lmstudio-community'; Repo='Qwen2.5-VL-3B-Instruct-GGUF';     File='Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf';     SizeGB=1.80; Desc='视觉模型主文件（可选）' }
  [pscustomobject]@{ Key='VL3B-mmproj';Author='lmstudio-community'; Repo='Qwen2.5-VL-3B-Instruct-GGUF';     File='mmproj-model-f16.gguf';                  SizeGB=1.25; Desc='视觉模型投影文件（可选，必须配套）' }
)

# ---- 3. 筛选 ----
$todo = $models
if ($CoreOnly) { $todo = $todo | Where-Object { $_.Key -in @('Qwen25-7B','HunyuanMT') } }
if (-not $WithVL) { $todo = $todo | Where-Object { $_.Key -notlike 'VL3B*' } }
if ($Only) { $todo = $todo | Where-Object { $_.Key -like "*$Only*" -or $_.Desc -like "*$Only*" } }
if (-not $todo) { Write-Host "没有匹配的模型（-Only $Only）" -ForegroundColor Yellow; exit 1 }

# ---- 4. 检查 curl ----
$curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if (-not $curl) { Write-Host "[!] 找不到 curl.exe（Win10 1803+ 自带）。可改用浏览器手动下载，见教程 §2。" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "本次计划下载 $($todo.Count) 个文件，合计约 $([math]::Round(($todo | Measure-Object SizeGB -Sum).Sum,1)) GB" -ForegroundColor Yellow
$todo | ForEach-Object { Write-Host ("  - {0,-16} {1,-45} {2} GB  {3}" -f $_.Key, $_.File, $_.SizeGB, $_.Desc) }

# ---- 4.5 空间检查：模型动辄十几 GB，别把 C 盘塞爆 ----
$needGB = [math]::Round(($todo | Measure-Object SizeGB -Sum).Sum, 1)
$drvLetter = ($modelsRoot -split ':')[0]
$freeGB = [math]::Round((Get-PSDrive $drvLetter -ErrorAction SilentlyContinue).Free / 1GB, 1)
Write-Host ""
Write-Host "目标盘 ${drvLetter}: 剩余 $freeGB GB，本次需要 $needGB GB" -ForegroundColor Cyan
if ($freeGB -lt ($needGB * 1.3)) {
  Write-Host "[!] 空间偏紧！模型会占满系统盘。" -ForegroundColor Red
  Write-Host "    建议先改模型目录：LM Studio 设置 → My Models → 换到空间大的盘（见教程 §2 路线 B）。" -ForegroundColor Red
  if (-not $Yes) {
    $go = Read-Host "    仍要继续吗？输入 y 继续，其它键退出"
    if ($go -ne 'y') { Write-Host "已取消。" ; exit 0 }
  }
}

Write-Host ""
Write-Host "按回车开始下载，Ctrl+C 取消（中断后重跑本脚本会自动续传）..." -ForegroundColor Yellow
if (-not $Yes) { Read-Host | Out-Null } else { Write-Host "(-Yes 模式：直接开始)" -ForegroundColor DarkGray }

# ---- 5. 逐个下载 ----
$fail = @()
foreach ($m in $todo) {
  $dir  = Join-Path (Join-Path $modelsRoot $m.Author) $m.Repo
  $dest = Join-Path $dir $m.File
  $part = "$dest.part"
  $url  = "https://hf-mirror.com/$($m.Author)/$($m.Repo)/resolve/main/$($m.File)"
  $expect = [int64]($m.SizeGB * 1GB)

  Write-Host ""
  Write-Host ("[{0}] {1}" -f $m.Key, $m.File) -ForegroundColor Cyan
  Write-Host "     目的: $dest"

  if ((Test-Path $dest) -and (Get-Item $dest).Length -gt ($expect * 0.9)) {
    Write-Host "     已存在且完整，跳过。" -ForegroundColor Green
    continue
  }
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $meter = if ($Yes) { '--no-progress-meter' } else { '--progress-bar' }
  & $curl -L -C - --retry 5 --retry-delay 3 --retry-all-errors --fail $meter -o $part $url
  $code = $LASTEXITCODE
  $sw.Stop()

  if ($code -ne 0) {
    Write-Host "     [!] 下载失败 (curl 退出码 $code)，已保留 $part，重跑本脚本可续传。" -ForegroundColor Red
    $fail += $m.Key
    continue
  }
  $size = (Get-Item $part).Length
  if ($size -lt ($expect * 0.9)) {
    Write-Host ("     [!] 文件偏小（{0} GB，预期 {1} GB），已保留 .part，请重跑续传。" -f [math]::Round($size/1GB,2), $m.SizeGB) -ForegroundColor Red
    $fail += $m.Key
    continue
  }
  Move-Item -Force $part $dest
  Write-Host ("     [OK] {0} GB，用时 {1} 分 {2} 秒，平均 {3} MB/s" -f `
      [math]::Round($size/1GB,2), $sw.Elapsed.Minutes, $sw.Elapsed.Seconds, `
      [math]::Round($size/1MB / [math]::Max($sw.Elapsed.TotalSeconds,1),1)) -ForegroundColor Green
}

# ---- 6. 收尾 ----
Write-Host ""
Write-Host "==================== 结果 ====================" -ForegroundColor Cyan
$lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
if (Test-Path $lms) { & $lms ls }
if ($fail.Count -gt 0) {
  Write-Host ""
  Write-Host "以下模型未完成：$($fail -join ', ')" -ForegroundColor Red
  Write-Host "直接重跑本脚本即可断点续传（不要删 .part 文件）。" -ForegroundColor Yellow
} else {
  Write-Host ""
  Write-Host "全部下载完成！回到 LM Studio 的 My Models 就能看到（看不到就按 Ctrl+R）。" -ForegroundColor Green
  Write-Host "下一步：按教程 §3 设置加载参数。" -ForegroundColor Green
}
