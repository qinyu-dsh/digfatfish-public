# install-watchdog.ps1 - register the DSH watchdog as a scheduled task running
# every 2 minutes (hidden window, current user, on-boot included).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-watchdog.ps1        (install)
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-watchdog.ps1 -Remove (uninstall)
param([switch]$Remove)

$task = 'DSH Watchdog'
$script = 'D:\dhs01\dsh-plugin-tools\watchdog-dsh.ps1'

if ($Remove) {
    schtasks /Delete /TN $task /F 2>&1 | Out-Null
    Write-Output "removed task: $task"
    exit 0
}

schtasks /Create /TN $task /SC MINUTE /MO 2 `
    /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" /F 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Output "ERROR: schtasks failed (exit $LASTEXITCODE)"
    exit 1
}
schtasks /Query /TN $task /FO LIST 2>&1 | Select-String -Pattern 'TaskName|Status|Next Run|下次运行' | ForEach-Object { $_.Line }
Write-Output ''
Write-Output 'watchdog installed: every 2 minutes, logs to D:\dhs01\dsh-plugin-tools\watchdog.log'
Write-Output 'manual run: powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\watchdog-dsh.ps1'
