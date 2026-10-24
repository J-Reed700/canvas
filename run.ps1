# Downbeat: one-command setup and launcher for native Windows (PowerShell).
#
#   .\run.ps1                 set up anything missing, then open the studio
#   .\run.ps1 --setup         only set up (install / build), don't launch
#   .\run.ps1 --yes ...       install missing system packages without asking
#   .\run.ps1 --port 8766     any other flags go to `python -m downbeat`
#
# The POSIX twin of this script is run.sh; keep the two in step. On a fresh machine this offers to
# install ffmpeg, Python 3.10+ and Node.js 20.19+ through winget. Python and npm packages always go
# into this folder (.venv\ and node_modules\), never system-wide.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Windows PowerShell 5.1 wraps a native command's stderr in an ErrorRecord, which 'Stop' turns into
# a fatal error even when the tool exited 0 -- and pip, npm and ffmpeg all chat on stderr. PS 7+ has
# a switch for this; 5.1 does not, so every native call goes through Invoke-Native below, which
# merges stderr into stdout and reports the exit code instead.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# Run a native command, streaming its output, and return its exit code without ever throwing on
# stderr. Pass -Quiet to capture output instead of showing it.
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @(),
        [switch]$Quiet
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Quiet) {
            $script:NativeOutput = (& $Exe @Arguments 2>&1 | Out-String)
        } else {
            $script:NativeOutput = ''
            & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host $_ }
        }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
}

Set-Location -LiteralPath $PSScriptRoot

$SetupOnly = $false
$AssumeYes = ($env:DOWNBEAT_YES -eq '1')
$ForwardArgs = @()
foreach ($a in $args) {
    switch ($a) {
        '--setup' { $SetupOnly = $true }
        '-y'      { $AssumeYes = $true }
        '--yes'   { $AssumeYes = $true }
        default   { $ForwardArgs += $a }
    }
}

function Say  { param($m) Write-Host '==> ' -ForegroundColor Green -NoNewline; Write-Host $m }
function Warn { param($m) Write-Host '!!  ' -ForegroundColor Yellow -NoNewline; Write-Host $m }
function Die  { param($m) Write-Host 'Error: ' -ForegroundColor Red -NoNewline; Write-Host $m; exit 1 }

# Ask before installing anything outside this folder. Non-interactive (CI, scripts) without --yes
# prints the command instead and stops.
function Confirm-Step {
    param([string]$Prompt, [string]$Manual)
    if ($AssumeYes) { return }
    $interactive = -not [Console]::IsInputRedirected
    if (-not $interactive) { Die "$Manual" }
    Write-Host '??  ' -ForegroundColor Cyan -NoNewline
    $reply = Read-Host "$Prompt [Y/n]"
    if ($reply -match '^[nN]') { Die "$Manual" }
}

function Have { param($name) return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# winget writes new shims to the user/machine PATH, but this process keeps its stale copy. Re-read
# both scopes so a just-installed tool is callable without reopening the terminal.
function Update-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Install-Winget {
    param([string]$Id, [string]$What, [string]$Override)
    if (-not (Have 'winget')) {
        Die "Couldn't find winget to install $What. Install $What yourself, then run .\run.ps1 again. (winget ships with App Installer from the Microsoft Store.)"
    }
    Confirm-Step "Install $What with winget (winget install $Id)?" "Run: winget install --id $Id -e"
    $wingetArgs = @(
        'install', '--id', $Id, '-e', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements'
    )
    if ($Override) { $wingetArgs += @('--override', $Override) }
    $code = Invoke-Native 'winget' $wingetArgs
    # winget returns 0x8A150061 / -1978335135 when the package is already installed; that's a success
    # for our purposes, as is a reboot-pending code.
    if ($code -ne 0 -and $code -ne -1978335135 -and $code -ne -1978335189) {
        Die "winget failed to install $What (exit $code). Install it yourself, then run .\run.ps1 again."
    }
    Update-Path
}

# ---------------------------------------------------------------- ffmpeg

if (-not (Have 'ffmpeg') -or -not (Have 'ffprobe')) {
    Update-Path
}
if (-not (Have 'ffmpeg') -or -not (Have 'ffprobe')) {
    Warn 'ffmpeg (video encoding and analysis) is not installed.'
    Install-Winget 'Gyan.FFmpeg' 'ffmpeg'
    if (-not (Have 'ffmpeg')) {
        Die "ffmpeg still isn't on PATH. Open a new terminal and run .\run.ps1 again."
    }
}

# Proxies and some exports encode with libx264, so a build without it can't be used.
function Test-X264 {
    Invoke-Native 'ffmpeg' @('-hide_banner', '-encoders') -Quiet | Out-Null
    return ($script:NativeOutput -match 'libx264')
}
if (-not (Test-X264)) {
    Die "This ffmpeg can't encode H.264 with libx264, which Downbeat needs. Install a full ffmpeg build (one listing libx264 in 'ffmpeg -encoders') and put it first on your PATH."
}

# ---------------------------------------------------------------- Python + .venv

$VenvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'

# Candidates must be real interpreters that can also build a venv. The Microsoft Store shims under
# WindowsApps\ answer --version but report "No suitable Python runtime found" under a bare `py -3`,
# so resolve each candidate to its actual executable and skip those.
function Resolve-PyTarget {
    param([string]$Exe, [string[]]$Prefix = @())
    # Keep the probe free of quote characters: PowerShell 5.1 rewrites embedded quotes on the way to
    # a native exe, which reaches Python as a syntax error. Version gate goes through the exit code.
    $probe = @($Prefix) + @('-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)')
    $code = Invoke-Native $Exe $probe -Quiet
    if ($code -ne 0) { return $null }
    # Version is fine; now ask where it lives (separate call, still quote-free).
    $code = Invoke-Native $Exe (@($Prefix) + @('-c', 'import sys; print(sys.executable)')) -Quiet
    if ($code -ne 0) { return $null }
    # A stub prints its "No suitable Python runtime found" notice here, so take the last real line.
    $out = ($script:NativeOutput -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
    if (-not $out) { return $null }
    $out = $out.Trim()
    if ($out -match '\\WindowsApps\\') { return $null }
    if (-not (Test-Path -LiteralPath $out)) { return $null }
    return $out
}

# Returns the python.exe to build the venv with, or $null when none is usable.
function Find-Python {
    if ($env:PYTHON) {
        $r = Resolve-PyTarget $env:PYTHON
        if ($r) { return $r }
    }
    # The py launcher sees per-user installs that never land on PATH; ask it for newest first.
    if (Have 'py') {
        foreach ($v in '-3.13', '-3.12', '-3.11', '-3.10') {
            $r = Resolve-PyTarget 'py' @($v)
            if ($r) { return $r }
        }
    }
    foreach ($c in 'python3', 'python') {
        if (Have $c) {
            $r = Resolve-PyTarget $c
            if ($r) { return $r }
        }
    }
    return $null
}

if (-not (Test-Path -LiteralPath $VenvPython)) {
    $pyExe = Find-Python
    if (-not $pyExe) {
        Warn 'Python 3.10 or newer is not installed.'
        # InstallAllUsers=0 keeps it per-user (no admin); PrependPath makes it visible to later runs.
        Install-Winget 'Python.Python.3.12' 'Python 3' 'InstallAllUsers=0 PrependPath=1 Include_launcher=1'
        $pyExe = Find-Python
        if (-not $pyExe) {
            Die 'Python 3.10+ still not found. Open a new terminal and run .\run.ps1 again, or install it from https://www.python.org/downloads/'
        }
    }
    Invoke-Native $pyExe @('--version') -Quiet | Out-Null
    Say "Creating .venv with $($script:NativeOutput.Trim())"
    $code = Invoke-Native $pyExe @('-m', 'venv', '.venv')
    if ($code -ne 0 -or -not (Test-Path -LiteralPath $VenvPython)) {
        Remove-Item -Recurse -Force -LiteralPath (Join-Path $PSScriptRoot '.venv') -ErrorAction SilentlyContinue
        Die "Could not create a virtual environment with $pyExe."
    }
}

# (Re)install the Python package when it's missing or pyproject.toml changed (e.g. after git pull).
$Stamp = Join-Path $PSScriptRoot '.venv\.downbeat-installed'
$needPyInstall = $false
if (-not (Test-Path -LiteralPath $Stamp)) {
    $needPyInstall = $true
} elseif ((Get-Item 'pyproject.toml').LastWriteTimeUtc -gt (Get-Item $Stamp).LastWriteTimeUtc) {
    $needPyInstall = $true
} else {
    $code = Invoke-Native $VenvPython @('-c', 'import cv2, numpy') -Quiet
    if ($code -ne 0) { $needPyInstall = $true }
}
if ($needPyInstall) {
    Say 'Installing Python packages into .venv (numpy, opencv)'
    $code = Invoke-Native $VenvPython @('-m', 'pip', 'install', '--upgrade', 'pip', '-q')
    if ($code -ne 0) { Die 'Could not upgrade pip inside .venv.' }
    $code = Invoke-Native $VenvPython @('-m', 'pip', 'install', '-e', '.', '-q')
    if ($code -ne 0) { Die 'Could not install the downbeat package into .venv.' }
    New-Item -ItemType File -Path $Stamp -Force | Out-Null
}

# ---------------------------------------------------------------- Node + studio build

function Get-NodeVersion {
    if (-not (Have 'node')) { return '' }
    Invoke-Native 'node' @('-v') -Quiet | Out-Null
    return $script:NativeOutput.Trim()
}

# Vite 8 needs Node 20.19+, 22.12+, or anything newer. Parsed here rather than with `node -e`:
# PowerShell 5.1 strips the quotes out of an inline script on the way to a native exe.
function Test-NodeOk {
    $v = Get-NodeVersion
    if ($v -notmatch '^v?(\d+)\.(\d+)\.') { return $false }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    if ($major -gt 22) { return $true }
    if ($major -eq 22) { return ($minor -ge 12) }
    if ($major -eq 20) { return ($minor -ge 19) }
    return $false
}

$DistIndex = Join-Path $PSScriptRoot 'downbeat\studio\dist\index.html'
$NodeModules = Join-Path $PSScriptRoot 'node_modules'

# Rebuild when dist is missing or any studio source (or build config) is newer than the built index.
$needBuild = $false
if (-not (Test-Path -LiteralPath $DistIndex)) {
    $needBuild = $true
} else {
    $builtAt = (Get-Item -LiteralPath $DistIndex).LastWriteTimeUtc
    $distDir = Join-Path $PSScriptRoot 'downbeat\studio\dist'
    $newer = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'downbeat\studio') -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { -not $_.FullName.StartsWith($distDir, [StringComparison]::OrdinalIgnoreCase) } |
        Where-Object { $_.LastWriteTimeUtc -gt $builtAt } |
        Select-Object -First 1
    if ($newer) { $needBuild = $true }
    foreach ($cfg in 'package.json', 'vite.config.ts') {
        if ((Get-Item -LiteralPath (Join-Path $PSScriptRoot $cfg)).LastWriteTimeUtc -gt $builtAt) { $needBuild = $true }
    }
}

if ($needBuild -or -not (Test-Path -LiteralPath $NodeModules)) {
    if (-not (Test-NodeOk)) { Update-Path }
    if (-not (Test-NodeOk)) {
        if (Have 'node') {
            Warn "Node.js $(Get-NodeVersion) is too old; the studio build needs 20.19+ or 22.12+."
        } else {
            Warn 'Node.js (used to build the studio UI) is not installed.'
        }
        Install-Winget 'OpenJS.NodeJS.LTS' 'Node.js LTS'
        if (-not (Test-NodeOk)) {
            Die 'Node.js 20.19+ still not found. Open a new terminal and run .\run.ps1 again.'
        }
    }
}

# npm ships as npm.cmd on Windows; call it through cmd so PowerShell doesn't try to parse the shim.
function Invoke-Npm {
    param([string[]]$NpmArgs)
    # Prefer npm.cmd: Get-Command 'npm' can resolve to npm.ps1, which PowerShell would re-parse.
    $npmCmd = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if (-not $npmCmd) {
        $nodeDir = Split-Path (Get-Command 'node' -ErrorAction SilentlyContinue).Source -Parent
        $candidate = if ($nodeDir) { Join-Path $nodeDir 'npm.cmd' } else { $null }
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Invoke-Native $candidate $NpmArgs)
        }
        Die 'npm not found on PATH even though Node.js is installed.'
    }
    return (Invoke-Native $npmCmd.Source $NpmArgs)
}

$LockStamp = Join-Path $NodeModules '.package-lock.json'
$needNpmInstall = $false
if (-not (Test-Path -LiteralPath $NodeModules)) {
    $needNpmInstall = $true
} elseif (-not (Test-Path -LiteralPath $LockStamp)) {
    $needNpmInstall = $true
} elseif ((Get-Item -LiteralPath (Join-Path $PSScriptRoot 'package-lock.json')).LastWriteTimeUtc -gt (Get-Item -LiteralPath $LockStamp).LastWriteTimeUtc) {
    $needNpmInstall = $true
}
if ($needNpmInstall) {
    Say 'Installing studio packages into node_modules (npm ci)'
    # npm ci needs the lockfile to match package.json exactly; fall back to install when it doesn't.
    if ((Invoke-Npm @('ci', '--no-audit', '--no-fund', '--loglevel=error')) -ne 0) {
        if ((Invoke-Npm @('install', '--no-audit', '--no-fund', '--loglevel=error')) -ne 0) {
            Die 'Could not install studio packages with npm.'
        }
    }
    $needBuild = $true
}

if ($needBuild) {
    Say 'Building the studio UI'
    if ((Invoke-Npm @('run', 'build', '--silent')) -ne 0) { Die 'The studio UI build failed.' }
}

if ($SetupOnly) {
    Say 'Setup complete. Start the studio with .\run.ps1'
    exit 0
}

Say 'Starting Downbeat'
# Run the server in the foreground without piping, so Ctrl+C reaches Python and the studio's own
# logging stays on its real streams. 'Continue' keeps a stderr line from aborting the shutdown path.
$ErrorActionPreference = 'Continue'
& $VenvPython -m downbeat @ForwardArgs
exit $LASTEXITCODE
