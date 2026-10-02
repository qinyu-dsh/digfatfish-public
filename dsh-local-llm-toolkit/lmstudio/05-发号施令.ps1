# ============================================================
#  05-发号施令.ps1  |  对本地模型分派任务（DSH 与本地模型之间的传令通道）
#
#  用法：
#     .\05-发号施令.ps1 翻译 "The quick brown fox jumps over the lazy dog."
#     .\05-发号施令.ps1 总结 -文件 "E:\某文档.txt"
#     .\05-发号施令.ps1 代码 "用 Python 写一个快速排序，带注释"
#     .\05-发号施令.ps1 润色 "这段话我是直译的……"
#     .\05-发号施令.ps1 提问 "解释一下什么是 KV cache"
#     "文本" | .\05-发号施令.ps1 翻译          # 也支持管道
#
#  它会自动：开服务器 -> 按任务挑模型 -> 加载 -> 长文自动分块 -> 打印速度 -> 卸载
#  加 -保持加载 可让模型留在显存里，方便连续派活
# ============================================================
param(
  [Parameter(Mandatory=$true, Position=0)]
  [ValidateSet('翻译','总结','代码','润色','提问')]
  [string]$任务,

  [Parameter(Position=1)]
  [string]$文本,

  [string]$文件,            # 从文件读入（UTF-8）
  [switch]$保持加载,         # 任务结束后不卸载模型
  [int]$分块字数 = 2000,     # 超过这个长度自动分块（上下文只有 8192）
  [int]$上下文 = 8192,
  [string]$附加系统提示 = ''
)

$ErrorActionPreference = 'Continue'   # 原生命令(lms)的 stderr 不该中断流程，失败由显式检查兜底
$lms  = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
$base = 'http://127.0.0.1:1234'

# ---- 岗位表：谁干什么、用什么脾气 ----
$岗位 = @{
  '翻译' = @{ Key='hunyuan-mt-7b';             Temp=0.3; Max=2048; Sys='你是专业翻译引擎。把用户给的文本翻译成中文（若原文已是中文则译为英文）。只输出译文，不要解释、不要加括号补充、不要总结。保留原有段落结构。' }
  '总结' = @{ Key='qwen2.5-7b-instruct';       Temp=0.3; Max=2048; Sys='你是文档分析助手。用简洁的中文书面语输出要点清单，只保留事实、数字、结论，分点列出。不要复述原文，不要客套话。' }
  '代码' = @{ Key='qwen2.5-coder-7b-instruct'; Temp=0.2; Max=2048; Sys='你是资深软件工程师。直接给出可运行的代码，关键处加简短注释，最后用一两句话说明用法。不要长篇解释。' }
  '润色' = @{ Key='qwen2.5-7b-instruct';       Temp=0.3; Max=2048; Sys='你是中文编辑。把用户给的文字改成通顺、书面、专业的中文，修正翻译腔，统一术语，不得改动任何数字和事实，不得添加原文没有的内容。只输出修改后的文字。' }
  '提问' = @{ Key='qwen2.5-7b-instruct';       Temp=0.7; Max=2048; Sys='你是知识助手。用准确、结构化的中文回答，必要时举例。不确定的地方明确说不确定，不要编造。' }
}
$role = $岗位[$任务]
if ($附加系统提示) { $role.Sys = $role.Sys + "`n" + $附加系统提示 }

function 说($m, $c='Gray') { Write-Host "  $m" -ForegroundColor $c }

# 静默执行 lms 子命令（原生程序写 stderr 会被 PS7 当成错误，这里吞掉）
function Lms([string[]]$参数) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
  try { (& $lms @参数 2>&1 | Out-String) } finally { $ErrorActionPreference = $old }
}

# 谁在岗（用官方状态接口，返回的是模型 id）
function 在岗模型 {
  try { return @((Invoke-RestMethod "$base/api/v0/models" -TimeoutSec 8).data | Where-Object { $_.state -in 'loaded','loading' } | ForEach-Object { $_.id }) }
  catch { return @() }
}

# ---- 1. 拿到文本 ----
if ($文件) {
  if (-not (Test-Path $文件)) { Write-Host "找不到文件: $文件" -ForegroundColor Red; exit 1 }
  $文本 = Get-Content $文件 -Raw -Encoding UTF8
}
if (-not $文本 -and [Console]::IsInputRedirected) { $文本 = [Console]::In.ReadToEnd() }
if (-not $文本 -or $文本.Trim() -eq '') { Write-Host "没有输入文本（用法见脚本头部注释）" -ForegroundColor Red; exit 1 }
$文本 = $文本.Trim()

Write-Host ""
Write-Host "任务: $任务    工人: $($role.Key)    输入: $($文本.Length) 字" -ForegroundColor Cyan

# ---- 2. 确保服务器在跑 ----
try { Invoke-RestMethod "$base/v1/models" -TimeoutSec 5 | Out-Null }
catch {
  说 "服务器没开，正在启动..." 'Yellow'
  Lms @('server','start') | Out-Null
  Start-Sleep -Seconds 4
}

# ---- 3. 让对的工人上岗（8G 显存一次只够一个 7B）----
$在岗 = 在岗模型
if ($在岗 -notcontains $role.Key) {
  foreach ($x in $在岗) { 说 "先让 $x 下班（腾显存）" 'DarkGray'; Lms @('unload', $x) | Out-Null }
  说 "正在让 $($role.Key) 上岗（加载 4.7GB，约 20-40 秒）..." 'Yellow'
  $out = Lms @('load', $role.Key, '--gpu', 'max', '-c', "$上下文", '-y')
  Start-Sleep -Seconds 2
  if ((在岗模型) -notcontains $role.Key) {
    Write-Host "加载失败。lms 返回：" -ForegroundColor Red
    Write-Host $out -ForegroundColor DarkGray
    exit 1
  }
  说 "上岗完成，当前显存占用 $((nvidia-smi --query-gpu=memory.used --format=csv,noheader))" 'Green'
} else { 说 "$($role.Key) 已在岗，直接派活" 'Green' }

$apiModel = $role.Key   # 状态接口返回的 id 就是 API 里要用的模型名

# ---- 4. 派活（长文本自动分块）----
function 问模型($user文本) {
  $body = @{ model=$apiModel; temperature=$role.Temp; max_tokens=$role.Max
             messages=@(@{role='system';content=$role.Sys}, @{role='user';content=$user文本}) } |
          ConvertTo-Json -Depth 6 -Compress
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod -Uri "$base/v1/chat/completions" -Method Post `
           -Body ([Text.Encoding]::UTF8.GetBytes($body)) `
           -ContentType 'application/json; charset=utf-8' -TimeoutSec 900
  } catch {
    Write-Host "请求失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
  }
  $sw.Stop()
  [pscustomobject]@{ 内容=$r.choices[0].message.content; 入=$r.usage.prompt_tokens; 出=$r.usage.completion_tokens; 秒=[math]::Round($sw.Elapsed.TotalSeconds,1) }
}

$块 = @()
if ($文本.Length -le $分块字数) { $块 = @($文本) }
else {
  $buf = ''
  foreach ($p in ($文本 -split "(\r?\n\s*\r?\n)")) {
    if (($buf.Length + $p.Length) -gt $分块字数 -and $buf.Trim()) { $块 += $buf.Trim(); $buf = '' }
    $buf += $p
  }
  if ($buf.Trim()) { $块 += $buf.Trim() }
  说 "文本较长，自动切成 $($块.Count) 块依次处理" 'Yellow'
}

$结果 = @(); $总出 = 0; $总入 = 0; $总秒 = 0.0
for ($i = 0; $i -lt $块.Count; $i++) {
  if ($块.Count -gt 1) { 说 "[$($i+1)/$($块.Count)] 处理中..." 'DarkGray' }
  $a = 问模型 $块[$i]
  $结果 += $a.内容
  $总入 += $a.入; $总出 += $a.出; $总秒 += $a.秒
  if ($块.Count -gt 1) { 说 "      $($a.出) tokens / $($a.秒)s" 'DarkGray' }
}

# ---- 5. 交活 ----
Write-Host ""
Write-Host "---------------- 结果 ----------------" -ForegroundColor Cyan
$结果 -join "`n`n"
Write-Host "--------------------------------------" -ForegroundColor Cyan
Write-Host ("共 $($块.Count) 块   入 $总入 / 出 $总出 tokens   耗时 $([math]::Round($总秒,1))s   速度 $([math]::Round($总出/[math]::Max($总秒,0.1),1)) token/s") -ForegroundColor Yellow

if (-not $保持加载) {
  Lms @('unload', $apiModel) | Out-Null
  说 "已让 $($role.Key) 下班，显存已释放（加 -保持加载 可让它留岗）" 'DarkGray'
}
