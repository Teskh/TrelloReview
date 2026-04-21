param(
    [string]$MirrorRoot = (Join-Path $env:USERPROFILE "build\Trello"),
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
    param(
        [string]$Label,
        [scriptblock]$Action
    )

    Write-Host "==> $Label"
    & $Action
}

function Assert-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found on PATH."
    }
}

Assert-Command "py"

$SourceRoot = $PSScriptRoot
$MirrorRoot = [System.IO.Path]::GetFullPath($MirrorRoot)
$VenvRoot = Join-Path $MirrorRoot ".venv"
$VenvPython = Join-Path $VenvRoot "Scripts\python.exe"
$DistRoot = Join-Path $MirrorRoot "dist\Trello Review"
$ExePath = Join-Path $DistRoot "Trello Review.exe"

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

function Get-WslSourceInfo {
    param([string]$Path)

    if ($Path -match '^\\\\wsl\$\\([^\\]+)(\\.*)?$') {
        $distro = $Matches[1]
        $suffix = $Matches[2]
        $linuxPath = if ([string]::IsNullOrWhiteSpace($suffix)) {
            "/"
        } else {
            ($suffix -replace '\\', '/')
        }
        return @{
            Distro = $distro
            LinuxPath = $linuxPath
        }
    }
    return $null
}

function ConvertTo-BashSingleQuotedLiteral {
    param([string]$Value)

    $escaped = $Value -replace "'", ("'" + '"' + "'" + '"' + "'")
    return "'" + $escaped + "'"
}

Invoke-Step "Mirroring WSL repo into Windows build folder" {
    New-Item -ItemType Directory -Path $MirrorRoot -Force | Out-Null

    $WslSource = Get-WslSourceInfo -Path $SourceRoot
    if ($null -ne $WslSource) {
        Assert-Command "wsl"
        Assert-Command "tar"

        Get-ChildItem -LiteralPath $MirrorRoot -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne ".venv" } |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

        $TempTarLinux = "/tmp/trello-build-{0}.tar" -f ([guid]::NewGuid().ToString("N"))
        $ExcludeArgs = $ExcludedDirs | ForEach-Object { "--exclude=$_" }
        $QuotedLinuxPath = ConvertTo-BashSingleQuotedLiteral $WslSource.LinuxPath
        $QuotedTempTarLinux = ConvertTo-BashSingleQuotedLiteral $TempTarLinux
        $TarCommand = @(
            "set -e",
            ("cd {0}" -f $QuotedLinuxPath),
            ("tar {0} -cf {1} ." -f ($ExcludeArgs -join " "), $QuotedTempTarLinux)
        ) -join "; "

        try {
            & wsl.exe -d $WslSource.Distro bash -lc $TarCommand
            if ($LASTEXITCODE -ne 0) {
                throw "WSL tar export failed with exit code $LASTEXITCODE"
            }

            $TempTarWindows = "\\wsl$\{0}{1}" -f $WslSource.Distro, ($TempTarLinux -replace '/', '\')
            & tar -xf $TempTarWindows -C $MirrorRoot
            if ($LASTEXITCODE -ne 0) {
                throw "Windows tar extract failed with exit code $LASTEXITCODE"
            }
        }
        finally {
            & wsl.exe -d $WslSource.Distro bash -lc ("rm -f {0}" -f $QuotedTempTarLinux) | Out-Null
        }
    } else {
        Assert-Command "robocopy"
        $RobocopyArgs = @(
            $SourceRoot,
            $MirrorRoot,
            "/MIR",
            "/R:2",
            "/W:1",
            "/NFL",
            "/NDL",
            "/NJH",
            "/NJS",
            "/NP",
            "/XD"
        ) + $ExcludedDirs

        & robocopy @RobocopyArgs
        $RobocopyCode = $LASTEXITCODE
        if ($RobocopyCode -gt 7) {
            throw "robocopy failed with exit code $RobocopyCode"
        }
    }
}

Invoke-Step "Cleaning stale Windows build artifacts" {
    foreach ($Path in @(
        (Join-Path $MirrorRoot "build"),
        (Join-Path $MirrorRoot "dist")
    )) {
        if (Test-Path $Path) {
            Remove-Item -Recurse -Force $Path
        }
    }
}

Invoke-Step "Creating Windows virtual environment if needed" {
    if (-not (Test-Path $VenvPython)) {
        & py -m venv $VenvRoot
    }
}

if (-not $SkipDependencyInstall) {
    Invoke-Step "Installing build dependencies" {
        & $VenvPython -m pip install -r (Join-Path $MirrorRoot "requirements.txt")
    }
}

Invoke-Step "Running PyInstaller" {
    Push-Location $MirrorRoot
    try {
        & $VenvPython -m PyInstaller "Trello Review.spec"
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path $ExePath)) {
    throw "Build finished but '$ExePath' was not found."
}

Write-Host ""
Write-Host "Build complete."
Write-Host "Mirror root: $MirrorRoot"
Write-Host "Deliver this folder: $DistRoot"
Write-Host "Run this file: $ExePath"
