# watchdog-common.ps1 - shared helpers for the DSH watchdog / snapshot / rollback trio.
# Dot-source from sibling scripts: . "$PSScriptRoot\watchdog-common.ps1"
# Windows PowerShell 5.1 compatible.

$WdScriptRoot = $PSScriptRoot
$WdStateFile  = Join-Path $WdScriptRoot 'watchdog-state.json'
$WdLogFile    = Join-Path $WdScriptRoot 'watchdog.log'
$WdSnapRoot   = 'D:\dhs01\dsh-profile-backup\snapshots'
$WdProfileDir = Join-Path $HOME '.dsh\profiles\web'
$WdTrio       = @('package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml')

function Get-WdState {
    if (Test-Path $WdStateFile) {
        try { return (Get-Content $WdStateFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { }
    }
    return [pscustomobject]@{
        profileHash = ''
        state = 'init'
        pendingSnapshot = ''
        lastHealthySnapshot = ''
        lastCheck = ''
        lastServerPid = 0
        consecutiveFailures = 0
        lastLogSize = 0
    }
}

function Set-WdState([object]$State) {
    $State.lastCheck = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    $json = $State | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($WdStateFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-WdEvent([string]$Level, [string]$Message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [$Level] $Message"
    Add-Content -Path $WdLogFile -Value $line -Encoding UTF8
    Write-Output $line
}

function Get-ProfileHash {
    $h = ''
    foreach ($f in $WdTrio) {
        $p = Join-Path $WdProfileDir $f
        if (Test-Path $p) {
            $fh = (Get-FileHash $p -Algorithm SHA256).Hash
            $h += $fh.Substring(0, 16)
        } else {
            $h += ('MISSING:' + $f)
        }
    }
    return $h
}

function Get-CoreVersion {
    try {
        $pkg = Join-Path $env:APPDATA 'npm/node_modules/@deepseek-ai/dsh/package.json'
        if (Test-Path $pkg) { return (Get-Content $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).version }
    } catch { }
    return 'unknown'
}

function Get-DbUserVersion {
    $db = Join-Path $HOME '.dsh/sessions/sessions.sqlite'
    if (-not (Test-Path $db)) { return -1 }
    try {
        $v = & node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('PRAGMA user_version').get().user_version);" "$db" 2>$null | Select-Object -First 1
        if ("$v" -match '^\d+$') { return [int]$v }
    } catch { }
    return -1
}

function Get-BundleList {
    $pkg = Join-Path $WdProfileDir 'package.json'
    if (-not (Test-Path $pkg)) { return '' }
    try {
        $j = Get-Content $pkg -Raw -Encoding UTF8 | ConvertFrom-Json
        return (($j.dsh.profile.bundles | ForEach-Object { "$_" }) -join ',')
    } catch { return '' }
}

function Get-ServerPid {
    $conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
    return 0
}

function Test-ServerHealthy {
    $conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $false }
    # core >= 0.1.5 gates the index behind a launch token and answers 401 until the
    # token cookie is present, so "any HTTP response" means the server is alive.
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/api/plugin-manager/failures' -UseBasicParsing -TimeoutSec 5
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch {
        try {
            $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3080/' -UseBasicParsing -TimeoutSec 5
            return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
        } catch {
            if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -gt 0) { return $true }
            return $false
        }
    }
}

# Scan the tail of dsh-server.log for crash signatures. Returns $true if new
# crash-marker lines appeared since the recorded byte offset.
function Test-LogCrash([long]$LastSize) {
    $log = 'D:\dhs01\dsh-desktop\dsh-server.log'
    if (-not (Test-Path $log)) { return $false }
    $len = (Get-Item $log).Length
    $stream = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
    try {
        $start = [Math]::Min([long]$LastSize, $len)
        if ($start -lt 0) { $start = 0 }
        $stream.Seek($start, [System.IO.SeekOrigin]::Begin) | Out-Null
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true)
        $newText = $reader.ReadToEnd()
        $reader.Close()
        $sig = 'Node\.js v\d+|plugin tree failed to load|ValidationError|uncaughtException|Cannot find module|failed to apply loader|Error: dsh:'
        if ($newText -match $sig) { return $true }
    } catch { } finally { $stream.Close() }
    return $false
}

function Get-LogSize {
    $log = 'D:\dhs01\dsh-desktop\dsh-server.log'
    if (Test-Path $log) { return (Get-Item $log).Length }
    return 0
}
