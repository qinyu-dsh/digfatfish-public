# manage-plugins.ps1 - list / enable / disable loader plugin entries of a dsh
# profile through its user patch layer (cordis.patch.yml).
#
# Like a RimWorld mod list, but for the DeepSeek Harness plugin tree:
#   list                 show every loader entry with ON/OFF state
#   disable <entry-id>   turn an entry off (adds `disabled: true` to the patch)
#   enable  <entry-id>   turn an entry back on (removes the row)
#
# Safety (hardened after the 2026-08-17 session-title crash):
#   - every edit is backed up to .\backups\ first;
#   - after the edit the tool runs TWO checks:
#       1. composition check  (dsh --profile <name> --dump-config)
#       2. BOOT PROBE         (boots a real second instance on a spare port)
#     dump-config alone is NOT enough: it does not validate configs, so a
#     patch that wipes a required field can still show exit 0 there while
#     breaking startup. Only a real boot proves the patch is safe.
#   - if either check fails the backup is restored automatically;
#   - the running server is NEVER touched - changes take effect on the next
#     `dsh web` restart.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File manage-plugins.ps1 list
#   powershell -NoProfile -ExecutionPolicy Bypass -File manage-plugins.ps1 disable <entry-id>
#   powershell -NoProfile -ExecutionPolicy Bypass -File manage-plugins.ps1 enable <entry-id>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('list', 'disable', 'enable', 'help')]
    [string]$Action,
    [Parameter(Position = 1)]
    [string]$Id = '',
    [string]$Profile = 'web',
    [switch]$SkipCheck
)
$ErrorActionPreference = 'Stop'

$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$backupDir = Join-Path $PSScriptRoot 'backups'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-ComposedTree {
    $out = & dsh --profile $Profile --dump-config 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "dump-config failed (exit $LASTEXITCODE) - the profile composition is broken; refusing to continue."
    }
    return , $out
}

function Invoke-BootProbe([int]$TimeoutSeconds = 60) {
    # Boot a real second dsh web instance on an OS-assigned port and verify it
    # serves HTTP. The only check that proves the current patch actually boots.
    $logFile = Join-Path $PSScriptRoot 'probe.log'
    Remove-Item $logFile -ErrorAction SilentlyContinue
    $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
    $cmd = if ($dshCmd) { "dsh --profile $Profile --no-open --port 0" } else { "npx --yes @deepseek-ai/dsh --profile $Profile --no-open --port 0" }
    $bootstrap = "`$ErrorActionPreference='Continue'; " + $cmd + " *>> '" + $logFile + "'"
    $p = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $bootstrap `
        -PassThru -WindowStyle Hidden
    $url = $null
    for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Path $logFile) {
            $m = Select-String -Path $logFile -Pattern 'http://127\.0\.0\.1:\d+' | Select-Object -First 1
            if ($m) { $url = $m.Matches[0].Value; break }
        }
        if ($p.HasExited) { break }
    }
    $ok = $false
    if ($url) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
            $ok = ($r.StatusCode -eq 200)
        } catch { $ok = $false }
    }
    if (-not $p.HasExited) { taskkill /PID $p.Id /T /F | Out-Null }
    Remove-Item $logFile -ErrorAction SilentlyContinue
    return $ok
}

function Get-PatchUserOffIds {
    $set = New-Object System.Collections.Generic.HashSet[string]
    if (-not (Test-Path $patchFile)) { return , $set }
    $lines = [System.IO.File]::ReadAllLines($patchFile, [System.Text.Encoding]::UTF8)
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $m = [regex]::Match($lines[$i], '^- id:\s*(\S+)')
        if ($m.Success) {
            $rowId = $m.Groups[1].Value
            for ($j = $i + 1; $j -lt $lines.Count -and $lines[$j] -match '^\s'; $j++) {
                if ($lines[$j] -match '^\s+disabled:\s*true\s*$') { [void]$set.Add($rowId); break }
            }
        }
    }
    return , $set
}

function Show-List {
    $out = Get-ComposedTree
    $entries = New-Object System.Collections.Generic.List[object]
    $cur = $null
    $source = ''
    foreach ($line in $out) {
        $m = [regex]::Match($line, '^# ==\s*(.+)$')
        if ($m.Success) { $source = $m.Groups[1].Value.Trim(); continue }
        $m = [regex]::Match($line, '^- id:\s*(\S+)\s*$')
        if ($m.Success) {
            $cur = [pscustomobject]@{ Id = $m.Groups[1].Value; Name = ''; Disabled = $false; Source = $source }
            $entries.Add($cur)
            continue
        }
        if ($null -ne $cur) {
            $m = [regex]::Match($line, "^\s+name:\s*'([^']+)'")
            if ($m.Success) { $cur.Name = $m.Groups[1].Value }
            if ($line -match '^\s+disabled:\s*true\s*$') { $cur.Disabled = $true }
        }
    }
    $userOff = Get-PatchUserOffIds
    $on = 0; $off = 0
    foreach ($e in $entries) {
        if ($e.Disabled) { $off++ } else { $on++ }
        $mark = if ($e.Disabled) { 'OFF' } else { 'ON ' }
        $star = if ($userOff.Contains($e.Id)) { '  *disabled-in-patch' } else { '' }
        $name = if ($e.Name) { "  ($($e.Name))" } else { '' }
        $src = "  [$(if ($e.Source) { $e.Source } else { '?' })]"
        "[$mark] $($e.Id)$name$src$star"
    }
    "total: $($entries.Count)  (enabled $on, disabled $off)"
}

function Edit-Patch([string]$Mode) {
    if (-not $Id) { throw 'an entry id is required (run "list" to see ids)' }
    if (-not (Test-Path $patchFile)) { throw "patch file not found: $patchFile" }

    $tree = Get-ComposedTree
    $idExists = $false
    foreach ($line in $tree) {
        if ($line -match ('^- id:\s*' + [regex]::Escape($Id) + '\s*$')) { $idExists = $true; break }
    }
    if (-not $idExists) { throw "entry '$Id' not found in the composed profile tree (run 'list' for valid ids)" }

    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = Join-Path $backupDir "cordis.patch.yml.$stamp"
    Copy-Item $patchFile $backupPath
    "backup: $backupPath"

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($l in [System.IO.File]::ReadAllLines($patchFile, [System.Text.Encoding]::UTF8)) { $lines.Add($l) }

    $rowIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match ('^- id:\s*' + [regex]::Escape($Id) + '\s*$')) { $rowIdx = $i; break }
    }

    if ($Mode -eq 'disable') {
        if ($rowIdx -ge 0) {
            for ($j = $rowIdx + 1; $j -lt $lines.Count -and $lines[$j] -match '^\s'; $j++) {
                if ($lines[$j] -match '^\s+disabled:\s*true\s*$') { throw "'$Id' is already disabled in the patch" }
            }
            $lines.Insert($rowIdx + 1, '  disabled: true')
        } else {
            $replaced = $false
            for ($i = 0; $i -lt $lines.Count; $i++) {
                if ($lines[$i].Trim() -eq '[]') {
                    $lines[$i] = "- id: $Id"
                    $lines.Insert($i + 1, '  disabled: true')
                    $replaced = $true
                    break
                }
            }
            if (-not $replaced) { $lines.Add("- id: $Id"); $lines.Add('  disabled: true') }
        }
    } else {
        if ($rowIdx -lt 0) { throw "'$Id' has no row in the patch (nothing to enable)" }
        $removed = $false
        for ($j = $rowIdx + 1; $j -lt $lines.Count -and $lines[$j] -match '^\s'; $j++) {
            if ($lines[$j] -match '^\s+disabled:\s*true\s*$') { $lines.RemoveAt($j); $removed = $true; break }
        }
        if (-not $removed) { throw "'$Id' has a row but no 'disabled: true' in it" }
        $hasOther = $false
        for ($j = $rowIdx + 1; $j -lt $lines.Count -and $lines[$j] -match '^\s'; $j++) {
            if ($lines[$j].Trim() -and -not $lines[$j].Trim().StartsWith('#')) { $hasOther = $true; break }
        }
        if (-not $hasOther) { $lines.RemoveAt($rowIdx) }
        $hasRows = $false
        foreach ($l in $lines) { if ($l -match '^- id:') { $hasRows = $true; break } }
        if (-not $hasRows) {
            $foundEmpty = $false
            foreach ($l in $lines) { if ($l.Trim() -eq '[]') { $foundEmpty = $true; break } }
            if (-not $foundEmpty) { $lines.Add('[]') }
        }
    }

    [System.IO.File]::WriteAllLines($patchFile, $lines, $utf8NoBom)

    if (-not $SkipCheck) {
        try {
            [void](Get-ComposedTree)
            "check 1/2: composition OK (dump-config exit 0)"
            if (Invoke-BootProbe) {
                "check 2/2: boot probe OK (real start on a spare port)"
            } else {
                throw 'boot probe FAILED - the edited patch breaks startup'
            }
        } catch {
            Copy-Item $backupPath $patchFile -Force
            throw "check FAILED ($($_.Exception.Message)) - restored $backupPath; nothing was left changed"
        }
    }
    $word = if ($Mode -eq 'disable') { 'disabled' } else { 'enabled' }
    "'$Id' is now $word in the profile patch."
    'NOTE: takes effect after the next dsh web restart; the running server was not touched.'
}

switch ($Action) {
    'list'    { Show-List }
    'disable' { Edit-Patch 'disable' }
    'enable'  { Edit-Patch 'enable' }
    default   {
        @'
manage-plugins.ps1 - list / enable / disable dsh loader plugin entries

  list                 show every loader entry with ON/OFF state
  disable <entry-id>   turn an entry off (adds `disabled: true` to the patch)
  enable  <entry-id>   turn an entry back on (removes the row)

Edits go to the profile user patch layer (cordis.patch.yml) with an automatic
backup and TWO checks afterwards: a composition check (dump-config) and a
real BOOT PROBE on a spare port. A failed check restores the backup. The
running server is never touched; changes take effect after the next restart.
'@
    }
}
