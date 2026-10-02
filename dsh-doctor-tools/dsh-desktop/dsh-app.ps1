# DeepSeek Harness desktop launcher:
# 1) make sure the local server is running (hidden window, no console),
# 2) open the UI in an Edge app-mode window (standalone window + taskbar icon).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File dsh-app.ps1
$ErrorActionPreference = 'SilentlyContinue'

& (Join-Path $PSScriptRoot 'start-server.ps1')
if ($LASTEXITCODE -ne 0) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        'Failed to start the DeepSeek Harness server. Check dsh-server.log in the launcher folder.',
        'DeepSeek Harness',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    exit 1
}

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
if (-not (Test-Path $edge)) { $edge = (Get-Command msedge -ErrorAction SilentlyContinue).Source }

if ($edge) {
    Start-Process -FilePath $edge -ArgumentList '--app=http://127.0.0.1:3080'
} else {
    Start-Process 'http://127.0.0.1:3080'
}
exit 0
