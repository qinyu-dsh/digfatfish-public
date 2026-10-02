# install-doctor-shortcut.ps1 - create the "DSH 医生急救" shortcut inside the
# desktop folder "DSH 医生急救" (user's organized layout) for one-click recovery
# (dsh-doctor-oneclick.ps1). Idempotent; DeepSeek icon first.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File install-doctor-shortcut.ps1
$ErrorActionPreference = 'Stop'

$desktop = [Environment]::GetFolderPath('Desktop')
$folder = Join-Path $desktop 'DSH 医生急救'
if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
$shell = New-Object -ComObject WScript.Shell

$icon = 'D:\dhs01\dsh-plugin-tools\doctor-folder.ico'
if (-not (Test-Path $icon)) { $icon = 'D:\dhs01\dsh-desktop\deepseek.ico' }
if (-not (Test-Path $icon)) { $icon = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }

$lnk = $shell.CreateShortcut((Join-Path $folder 'DSH 医生急救.lnk'))
$lnk.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "D:\dhs01\dsh-plugin-tools\dsh-doctor-oneclick.ps1"'
$lnk.WorkingDirectory = 'D:\dhs01\dsh-plugin-tools'
$lnk.IconLocation = "$icon,0"
$lnk.Description = 'DSH 一键急救：探测配置 -> 正常则安全重启 / 损坏则回滚到最近健康快照 -> 验证 HTTP 200'
$lnk.Save()

Write-Host "Created: $folder\DSH 医生急救.lnk"
Write-Host 'Double-click it after a crash: it probes the config, restarts or rolls back, and verifies recovery.'
