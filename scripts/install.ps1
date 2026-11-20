# ZCode CLI installer / updater for the fork lemur-galago/ZCode.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-InstallDir <dir>]
# When run outside a clone (for example, right after downloading this single file),
# it clones the repository into .\ZCode under the current folder and re-invokes itself.
# English-only on purpose: PowerShell 5.1 misreads non-ASCII in scripts without a BOM.
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\ZCodeCLI",
    [string]$RepoUrl = "https://github.com/lemur-galago/ZCode.git",
    [string]$NodeVersion = "24.14.0"
)
$ErrorActionPreference = "Stop"

$selfDir = $PSScriptRoot
$repo = Split-Path $selfDir -Parent

# --- Bootstrap: running outside a clone -> clone into the current folder and re-invoke.
if (-not (Test-Path (Join-Path $repo "package.json"))) {
    $clone = Join-Path (Get-Location) "ZCode"
    if (Test-Path $clone) {
        Write-Host "Using existing clone: $clone"
    } else {
        Write-Host "Cloning $RepoUrl -> $clone"
        git clone $RepoUrl $clone
        if ($LASTEXITCODE -ne 0) { throw "git clone failed (is git installed?)" }
    }
    & (Join-Path $clone "scripts\install.ps1") -InstallDir $InstallDir -RepoUrl $RepoUrl -NodeVersion $NodeVersion
    exit $LASTEXITCODE
}

Write-Host "== ZCode CLI install"
Write-Host "   source repo : $repo"
Write-Host "   install dir : $InstallDir"

# --- Toolchain: a Node.js distribution with corepack (for pnpm).
$toolchain = Join-Path $repo ".toolchain"
$nodeDir = Join-Path $toolchain "node-v$NodeVersion-win-x64"
function Test-NodeDir([string]$dir) { Test-Path (Join-Path $dir "corepack.cmd") }

$useNode = $null
try { $sysNode = (Get-Command node -ErrorAction Stop).Source | Split-Path -Parent } catch { $sysNode = $null }
if ($sysNode -and (Test-NodeDir $sysNode)) { $useNode = $sysNode }
if (-not $useNode -and (Test-NodeDir $nodeDir)) { $useNode = $nodeDir }
if (-not $useNode) {
    New-Item -ItemType Directory -Force $toolchain | Out-Null
    $zip = Join-Path $toolchain "node-v$NodeVersion-win-x64.zip"
    if (-not (Test-Path $zip)) {
        Write-Host "Downloading Node.js v$NodeVersion..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $zip
    }
    if (-not (Test-NodeDir $nodeDir)) {
        Write-Host "Extracting Node.js..."
        Expand-Archive $zip -DestinationPath $toolchain -Force
    }
    $useNode = $nodeDir
}
$env:PATH = "$useNode;$env:PATH"
Write-Host "   node        : $useNode"

# --- Dependencies (pnpm install may report known-nonfatal failures: ssh2 optional build, root prepare).
Push-Location $repo
try {
    Write-Host "== pnpm install (first run takes a few minutes)"
    & (Join-Path $useNode "corepack.cmd") pnpm install --filter "@zcode/cli..."
    # pnpm install re-arms the upstream husky hooks; they call pnpm and would
    # break pushes on machines without a global pnpm. This fork does not use them.
    git config --unset core.hooksPath 2>$null | Out-Null
    Write-Host "== build"
    & (Join-Path $useNode "corepack.cmd") pnpm --filter "@zcode/cli..." build
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
    & (Join-Path $repo "node_modules\.bin\tsc.cmd") -b packages/shared --force
    if ($LASTEXITCODE -ne 0) { throw "tsc for @zcode/shared failed" }
} finally {
    Pop-Location
}

# --- Assemble the portable bundle.
Write-Host "== assemble portable"
& (Join-Path $useNode "node.exe") (Join-Path $repo "scripts\assemble-portable.mjs") --src $repo --install-dir $InstallDir --node $useNode
if ($LASTEXITCODE -ne 0) { throw "assemble failed" }
$info = Get-Content -Path (Join-Path $repo ".build\portable-info.json") -Raw | ConvertFrom-Json

# --- Install side-by-side and repoint the launcher.
New-Item -ItemType Directory -Force (Join-Path $InstallDir "versions") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $InstallDir "bin") | Out-Null
$versionRoot = Join-Path $InstallDir ("versions\" + $info.versionId)
if (Test-Path $versionRoot) { Remove-Item -Recurse -Force $versionRoot }
New-Item -ItemType Directory -Force $versionRoot | Out-Null
Copy-Item -Path $info.dir -Destination (Join-Path $versionRoot "ZCode-CLI-Portable") -Recurse
Set-Content -Path (Join-Path $InstallDir "source-repo.txt") -Value $repo -NoNewline
Copy-Item -Path (Join-Path $repo "scripts\zcode-launcher.cmd") -Destination (Join-Path $InstallDir "bin\zcode.cmd") -Force

Write-Host ""
Write-Host "== Installed $($info.versionId)"
Write-Host "   Open a new terminal and run: zcode"
