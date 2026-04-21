param(
    [string]$MirrorRoot = (Join-Path $env:USERPROFILE "build\Trello"),
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"

function Assert-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found on PATH."
    }
}

Assert-Command "py"
Assert-Command "wsl"
Assert-Command "tar"

$SourceRoot = $PSScriptRoot
$MirrorRoot = [System.IO.Path]::GetFullPath($MirrorRoot)
$VenvRoot = Join-Path $MirrorRoot ".venv"
$VenvPython = Join-Path $VenvRoot "Scripts\python.exe"
$DistRoot = Join-Path $MirrorRoot "dist\Trello Review"
$ExePath = Join-Path $DistRoot "Trello Review.exe"

if ($SourceRoot -notmatch '^\\\\wsl\$\\([^\\]+)(\\.*)?$') {
    throw "This script must be run from a \\wsl$\\... path."
}

$Distro = $Matches[1]
$Suffix = $Matches[2]
$LinuxPath = if ([string]::IsNullOrWhiteSpace($Suffix)) { "/" } else { $Suffix -replace '\\', '/' }

$ExcludedDirs = @(
    ".git",
    ".codex",
    "venv",
    "venv.",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "review_workspace"
)

Write-Host "==> Exporting WSL repo"
New-Item -ItemType Directory -Path $MirrorRoot -Force | Out-Null
Get-ChildItem -LiteralPath $MirrorRoot -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne ".venv" } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

$TempTarLinux = "/tmp/trello-build-$([guid]::NewGuid().ToString('N')).tar"
$ExcludeArgs = ($ExcludedDirs | ForEach-Object { "--exclude=$_" }) -join " "
$TarCommand = "set -e; cd '$LinuxPath'; tar $ExcludeArgs -cf '$TempTarLinux' ."

try {
    & wsl.exe -d $Distro bash -lc $TarCommand
    if ($LASTEXITCODE -ne 0) {
        throw "WSL tar export failed with exit code $LASTEXITCODE"
    }

    $TempTarWindows = "\\wsl$\$Distro" + ($TempTarLinux -replace '/', '\')

    Write-Host "==> Extracting mirror to $MirrorRoot"
    & tar -xf $TempTarWindows -C $MirrorRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Windows tar extract failed with exit code $LASTEXITCODE"
    }
}
finally {
    & wsl.exe -d $Distro bash -lc "rm -f '$TempTarLinux'" | Out-Null
}

Write-Host "==> Cleaning build output"
foreach ($Path in @((Join-Path $MirrorRoot "build"), (Join-Path $MirrorRoot "dist"))) {
    if (Test-Path $Path) {
        Remove-Item -Recurse -Force $Path
    }
}

Write-Host "==> Creating Windows venv if needed"
if (-not (Test-Path $VenvPython)) {
    & py -m venv $VenvRoot
}

if (-not $SkipDependencyInstall) {
    Write-Host "==> Installing dependencies"
    & $VenvPython -m pip install -r (Join-Path $MirrorRoot "requirements.txt")
}

Write-Host "==> Running PyInstaller"
Push-Location $MirrorRoot
try {
    & $VenvPython -m PyInstaller "Trello Review.spec"
}
finally {
    Pop-Location
}

if (-not (Test-Path $ExePath)) {
    throw "Build finished but '$ExePath' was not found."
}

Write-Host ""
Write-Host "Build complete."
Write-Host "Mirror root: $MirrorRoot"
Write-Host "Deliver this folder: $DistRoot"
Write-Host "Run this file: $ExePath"
