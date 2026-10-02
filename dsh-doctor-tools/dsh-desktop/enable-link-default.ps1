# Make `link:` the default for local plugin adds in `dsh plugin`.
#
# Patches the installed dsh CLI (global npm install + npx cache copy) so that
#   dsh plugin --profile web add file:./my-plugin   (snapshot copy)
#   dsh plugin --profile web add ./my-plugin        (bare relative path)
# both become `link:` installs (live symlink) instead of pnpm's `file:`
# snapshot copy. Registry packages and git URLs are untouched.
#
# NOTE: dsh upgrades restore the original file — re-run this script after
# every upgrade. Revert with:  powershell -File enable-link-default.ps1 -Revert
param([switch]$Revert)
$ErrorActionPreference = 'Stop'

# locate every installed copy of the dsh CLI lib dir
$files = @()
$globalLib = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib'
if (Test-Path $globalLib) { $files += Get-ChildItem $globalLib -Filter 'plugin-*.js' -ErrorAction SilentlyContinue }
$npxRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
if (Test-Path $npxRoot) {
    Get-ChildItem $npxRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $lib = Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib'
        if (Test-Path $lib) { $files += Get-ChildItem $lib -Filter 'plugin-*.js' -ErrorAction SilentlyContinue }
    }
}
$files = $files | Sort-Object FullName -Unique
if ($files.Count -eq 0) { throw 'no dsh plugin-*.js found under global or npx cache installs' }

# literal old/new pairs (single-quoted: backticks and ${} are literal)
$old1 = 'return `${match.groups.prefix ?? ""}${resolve(cwd, match.groups.path)}`;'
$new1 = 'return `link:${resolve(cwd, match.groups.path)}`;'
$old2 = 'if (match?.groups?.path === void 0) return argument;'
$new2 = 'if (match?.groups?.path === void 0) return argument.startsWith("file:") ? "link:" + argument.slice(5) : argument;'

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$patched = 0
foreach ($f in $files) {
    $content = [System.IO.File]::ReadAllText($f.FullName)
    $changed = $false
    if (-not $Revert) {
        if ($content.Contains($old1)) { $content = $content.Replace($old1, $new1); $changed = $true }
        if ($content.Contains($old2)) { $content = $content.Replace($old2, $new2); $changed = $true }
    } else {
        if ($content.Contains($new1)) { $content = $content.Replace($new1, $old1); $changed = $true }
        if ($content.Contains($new2)) { $content = $content.Replace($new2, $old2); $changed = $true }
    }
    if ($changed) {
        [System.IO.File]::WriteAllText($f.FullName, $content, $utf8NoBom)
        "PATCHED: $($f.FullName)"
        $patched++
    } else {
        "unchanged: $($f.FullName) $(if ($Revert) { '(already reverted or signature missing)' } else { '(already patched or signature missing)' })"
    }
}
"done: $patched file(s) $(if ($Revert) { 'reverted' } else { 'patched' })."
