# dsh-snapshot.ps1 - manage profile snapshots (package.json / cordis.patch.yml /
# pnpm-workspace.yaml + manifest) under D:\dhs01\dsh-profile-backup\snapshots.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File dsh-snapshot.ps1 -Take [-Name mylabel]
#   powershell -NoProfile -ExecutionPolicy Bypass -File dsh-snapshot.ps1 -List
#   powershell -NoProfile -ExecutionPolicy Bypass -File dsh-snapshot.ps1 -MarkHealthy -Name <snapshot>
param([switch]$Take, [switch]$List, [switch]$MarkHealthy, [string]$Name)

. "$PSScriptRoot\watchdog-common.ps1"

if (-not (Test-Path $WdSnapRoot)) { New-Item -ItemType Directory -Path $WdSnapRoot -Force | Out-Null }

if ($Take) {
    if (-not $Name) { $Name = 'auto-' + (Get-Date -Format 'yyyyMMdd-HHmmss') }
    $dest = Join-Path $WdSnapRoot $Name
    if (Test-Path $dest) { Write-Output "ERROR: snapshot $Name already exists"; exit 1 }
    New-Item -ItemType Directory -Path $dest | Out-Null
    foreach ($f in $WdTrio) {
        $src = Join-Path $WdProfileDir $f
        if (Test-Path $src) { Copy-Item $src (Join-Path $dest $f) }
        else { Write-Output "WARN: $f missing in profile" }
    }
    $manifest = [pscustomobject]@{
        name = $Name
        takenAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        profileHash = (Get-ProfileHash)
        bundles = (Get-BundleList)
        coreVersion = (Get-CoreVersion)
        dbUserVersion = (Get-DbUserVersion)
    }
    [System.IO.File]::WriteAllText((Join-Path $dest 'manifest.json'), ($manifest | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
    Write-WdEvent 'INFO' "snapshot taken: $Name (bundles: $($manifest.bundles))"
    Write-Output "snapshot: $dest"
    exit 0
}

if ($MarkHealthy) {
    if (-not $Name) { Write-Output 'ERROR: -MarkHealthy requires -Name <snapshot>'; exit 1 }
    $dest = Join-Path $WdSnapRoot $Name
    if (-not (Test-Path (Join-Path $dest 'package.json'))) { Write-Output "ERROR: snapshot $Name not found or incomplete"; exit 1 }
    $state = Get-WdState
    $state.lastHealthySnapshot = $Name
    $state.pendingSnapshot = ''
    $state.state = 'healthy'
    $state.consecutiveFailures = 0
    Set-WdState $state
    Write-WdEvent 'INFO' "snapshot marked healthy: $Name"
    Write-Output "marked healthy: $Name"
    exit 0
}

if ($List) {
    $state = Get-WdState
    Write-Output ('watchdog state: ' + $state.state + '  lastHealthy=' + $state.lastHealthySnapshot + '  pending=' + $state.pendingSnapshot)
    Write-Output ('current profileHash: ' + (Get-ProfileHash))
    Write-Output ('current bundles: ' + (Get-BundleList))
    Write-Output '--- snapshots ---'
    Get-ChildItem $WdSnapRoot -Directory | Sort-Object Name | ForEach-Object {
        $m = Join-Path $_.FullName 'manifest.json'
        $info = ''
        if (Test-Path $m) {
            try {
                $mj = Get-Content $m -Raw -Encoding UTF8 | ConvertFrom-Json
                $info = " taken=$($mj.takenAt) bundles=$($mj.bundles)"
            } catch { }
        }
        $flag = '   '
        if ($_.Name -eq $state.lastHealthySnapshot) { $flag = '[H]' }
        Write-Output ("$flag $($_.Name)$info")
    }
    exit 0
}

Write-Output 'Usage: dsh-snapshot.ps1 -Take [-Name x] | -List | -MarkHealthy -Name x'
exit 1
