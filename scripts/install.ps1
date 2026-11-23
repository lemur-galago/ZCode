# ZCode CLI installer / updater for the fork lemur-galago/ZCode.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-InstallDir <dir>] [-NoPathUpdate]
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Uninstall
# Fresh machine, nothing to download by hand (git must be installed):
#   irm https://raw.githubusercontent.com/lemur-galago/ZCode/main/scripts/install.ps1 | iex
# When run outside a clone it clones the repository into -SourceDir and re-invokes itself.
# Options, the daily update check and the uninstall: INSTALL-WINDOWS.md next to this file.
# English-only on purpose: PowerShell 5.1 misreads non-ASCII in scripts without a BOM.
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\ZCodeCLI",
    [string]$SourceDir  = "$env:LOCALAPPDATA\ZCodeCLI-src",   # a fixed folder, whatever the current one is
    [string]$RepoUrl = "https://github.com/lemur-galago/ZCode.git",
    [string]$NodeVersion = "24.14.0",
    [int]$KeepVersions = 3,          # installed versions to keep; 0 keeps all of them
    [switch]$NoPathUpdate,
    [switch]$SkipBuild,              # the tree is already built and assembled: only install
    [switch]$Uninstall
)

# A checkout is recognised by the files this installer needs, not by a package.json one level up.
# An empty root (the script was piped into the shell) is not one.
function Test-ZCodeCheckout([string]$Root) {
    if (-not $Root) { return $false }
    (Test-Path (Join-Path $Root "scripts\assemble-portable.mjs")) -and
    (Test-Path (Join-Path $Root "apps\zcode-cli\packages\cli\package.json"))
}

function Test-NodeDir([string]$Dir) { Test-Path (Join-Path $Dir "corepack.cmd") }

# External commands run with ErrorActionPreference=Continue: under Stop, PowerShell 5.1 turns every
# stderr line of an external command into a terminating error as soon as the output of this script
# is redirected (.\install.ps1 *> log.txt). Check $LASTEXITCODE after the call.
function Invoke-External([string]$File, [string[]]$Arguments) {
    $ErrorActionPreference = "Continue"
    & $File @Arguments
}

# The user PATH is read and written in the registry directly: `setx` cuts it at 1024 characters and
# mixes in the system PATH, [Environment]::SetEnvironmentVariable expands %USERPROFILE% entries and
# changes the value type.
$UserPathKey = "Environment"   # HKCU subkey; tests point it at a scratch key

function Get-UserPath {
    $raw = ""
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($UserPathKey)
    if ($key) {
        try {
            $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        } finally { $key.Close() }
    }
    [pscustomobject]@{
        Raw     = $raw
        Entries = @($raw -split ";" | Where-Object { $_.Trim() } |
            ForEach-Object { [Environment]::ExpandEnvironmentVariables($_.Trim()).TrimEnd("\") })
    }
}

function Set-UserPath([string]$Value) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($UserPathKey)
    try { $key.SetValue("Path", $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $key.Close() }
    # Tell Explorer, so that windows opened from now on get the new PATH.
    if (-not ("ZCode.NativeMethods" -as [type])) {
        Add-Type -Namespace ZCode -Name NativeMethods -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);'
    }
    $result = [IntPtr]::Zero
    [void][ZCode.NativeMethods]::SendMessageTimeout([IntPtr]0xFFFF, 0x1A, [IntPtr]::Zero, "Environment", 2, 1000, [ref]$result)
}

# Add <Dir> to the user PATH unless it is already there. Returns $true when the PATH changed.
function Add-UserPathEntry([string]$Dir) {
    $Dir = $Dir.TrimEnd("\")
    $path = Get-UserPath
    if ($path.Entries -contains $Dir) { return $false }
    $new = if ($path.Raw -eq "" -or $path.Raw.EndsWith(";")) { $path.Raw + $Dir } else { $path.Raw + ";" + $Dir }
    Set-UserPath $new
    return $true
}

# Remove <Dir> from the user PATH. Returns $true when the PATH changed.
function Remove-UserPathEntry([string]$Dir) {
    $Dir = $Dir.TrimEnd("\")
    $path = Get-UserPath
    if ($path.Entries -notcontains $Dir) { return $false }
    $kept = @($path.Raw -split ";" | Where-Object {
        $_.Trim() -and [Environment]::ExpandEnvironmentVariables($_.Trim()).TrimEnd("\") -ine $Dir
    })
    Set-UserPath ($kept -join ";")
    return $true
}

# Dot-sourcing defines the functions without installing (used by tests).
if ($MyInvocation.InvocationName -eq ".") { return }

# The PATH entry and every file operation need absolute paths, whatever the current folder is.
$InstallDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir).TrimEnd("\")
$SourceDir  = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SourceDir).TrimEnd("\")

if ($Uninstall) {
    $ErrorActionPreference = "Stop"
    if (-not (Test-Path (Join-Path $InstallDir "bin\zcode.cmd"))) {
        throw "$InstallDir does not look like a ZCode CLI install (no bin\zcode.cmd)"
    }
    if (-not $NoPathUpdate -and (Remove-UserPathEntry (Join-Path $InstallDir "bin"))) {
        Write-Host "Removed from user PATH: $(Join-Path $InstallDir 'bin')"
    }
    $sourceFile = Join-Path $InstallDir "source-repo.txt"   # read before the folder goes
    $source = if (Test-Path $sourceFile) { [IO.File]::ReadAllText($sourceFile).Trim() } else { "" }
    Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
    if (Test-Path $InstallDir) {
        Write-Warning "Some files in $InstallDir are in use (running zcode windows?). Close them and repeat."
    } else {
        Write-Host "Removed $InstallDir"
    }
    Write-Host "The source checkout is kept; delete it by hand when you no longer want updates: $source"
    exit 0
}

# --- Bootstrap: running outside a clone -> clone into the fixed -SourceDir and re-invoke.
$repo = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { "" }
if (-not (Test-ZCodeCheckout $repo)) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is required: https://git-scm.com/download/win" }
    $installer = Join-Path $SourceDir "scripts\install.ps1"
    if (-not (Test-ZCodeCheckout $SourceDir)) {
        if (Test-Path $SourceDir) { throw "$SourceDir exists but is not a ZCode checkout - move it away first" }
        Write-Host "Cloning $RepoUrl -> $SourceDir (a large repository, this takes a while)"
        Invoke-External git @("clone", $RepoUrl, $SourceDir)
        if ($LASTEXITCODE -ne 0) { throw "git clone failed (exit code $LASTEXITCODE)" }
    } else {
        Write-Host "Using existing clone: $SourceDir"
    }
    if ($PSScriptRoot) {
        $ErrorActionPreference = "Stop"
        $options = @{
            InstallDir   = $InstallDir
            SourceDir    = $SourceDir
            RepoUrl      = $RepoUrl
            NodeVersion  = $NodeVersion
            KeepVersions = $KeepVersions
            NoPathUpdate = $NoPathUpdate
        }
        & $installer @options
        exit $LASTEXITCODE
    }
    # Piped into the shell (`irm ... | iex`): the installer runs in a child process, so that it can
    # neither close this window with `exit` nor leave its settings behind in this session.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
    return
}

$ErrorActionPreference = "Stop"

Write-Host "== ZCode CLI install"
Write-Host "   source repo : $repo"
Write-Host "   install dir : $InstallDir"

if (-not $SkipBuild) {
    # --- Toolchain: a Node.js distribution with corepack (for pnpm). The version that builds also
    # becomes the portable runtime, so the system Node is used only when it is not older than
    # $NodeVersion: system > .toolchain cache > auto-download from nodejs.org.
    $toolchain = Join-Path $repo ".toolchain"
    $name = "node-v$NodeVersion-win-x64"
    $nodeDir = Join-Path $toolchain $name

    $useNode = $null
    try { $sysNode = (Get-Command node -ErrorAction Stop).Source | Split-Path -Parent } catch { $sysNode = $null }
    if ($sysNode -and (Test-NodeDir $sysNode)) {
        $sysVersion = [string](Invoke-External (Join-Path $sysNode "node.exe") @("--version"))
        if ($sysVersion -match "^v(\d+)\." -and [int]$Matches[1] -ge [int]($NodeVersion -split "\.")[0]) { $useNode = $sysNode }
    }
    if (-not $useNode -and (Test-NodeDir $nodeDir)) { $useNode = $nodeDir }
    if (-not $useNode) {
        New-Item -ItemType Directory -Force $toolchain | Out-Null
        $zip = Join-Path $toolchain "$name.zip"
        Remove-Item $zip -Force -ErrorAction SilentlyContinue   # a leftover archive may be incomplete
        $dist = "https://nodejs.org/dist/v$NodeVersion"
        $ProgressPreference = "SilentlyContinue"   # PS 5.1: the progress bar slows Invoke-WebRequest down many times over
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $downloaded = $false
        for ($attempt = 1; $attempt -le 3 -and -not $downloaded; $attempt++) {
            try {
                $sums = (Invoke-WebRequest "$dist/SHASUMS256.txt" -UseBasicParsing).Content
                if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }   # no text content type
                $expected = [regex]::Match($sums, '(?m)^([0-9a-fA-F]{64})\s+' + [regex]::Escape($name) + '\.zip\s*$').Groups[1].Value
                if (-not $expected) { throw "SHASUMS256.txt has no entry for $name.zip" }
                Write-Host "Downloading Node.js v$NodeVersion..."
                Invoke-WebRequest "$dist/$name.zip" -OutFile $zip -UseBasicParsing
                $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
                if ($actual -ine $expected) { throw "SHA256 mismatch (expected $expected, got $actual)" }
                $downloaded = $true
            } catch {
                Remove-Item $zip -Force -ErrorAction SilentlyContinue
                if ($attempt -eq 3) { throw "Could not download Node.js v${NodeVersion}: $($_.Exception.Message)" }
                Write-Warning "Download failed, trying again: $($_.Exception.Message)"
            }
        }
        Write-Host "Extracting Node.js..."
        Expand-Archive $zip -DestinationPath $toolchain -Force
        $useNode = $nodeDir
    }
    $env:PATH = "$useNode;$env:PATH"
    $corepack = Join-Path $useNode "corepack.cmd"
    Write-Host "   node        : $useNode"

    # --- Dependencies. pnpm install may report known-nonfatal failures: ssh2 optional build, and the
    # root prepare script, which calls a bare `pnpm` that does not exist outside corepack.
    # COREPACK_ENABLE_DOWNLOAD_PROMPT: no question when pnpm itself has to be downloaded.
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
    Push-Location $repo
    try {
        Write-Host "== pnpm install (first run takes a few minutes)"
        Invoke-External $corepack @("pnpm", "install", "--filter", "@zcode/cli...")
        $pnpmInstallCode = $LASTEXITCODE
        if ($pnpmInstallCode -ne 0) { Write-Warning "pnpm install exited with code $pnpmInstallCode (tolerated, see its output above)" }
        # pnpm install re-arms the upstream husky hooks; they call pnpm and would break pushes on
        # machines without a global pnpm. This fork does not use them.
        Invoke-External git @("config", "--unset", "core.hooksPath")

        Write-Host "== build"
        Invoke-External $corepack @("pnpm", "--filter", "@zcode/cli...", "build")
        if ($LASTEXITCODE -ne 0) {
            throw "build failed (build exit code $LASTEXITCODE, pnpm install exit code $pnpmInstallCode) - see the pnpm output above"
        }
        Invoke-External (Join-Path $repo "node_modules\.bin\tsc.cmd") @("-b", "packages/shared", "--force")
        if ($LASTEXITCODE -ne 0) { throw "tsc for @zcode/shared failed (exit code $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }

    # --- Assemble the portable bundle.
    Write-Host "== assemble portable"
    Invoke-External (Join-Path $useNode "node.exe") @(
        (Join-Path $repo "scripts\assemble-portable.mjs"), "--src", $repo, "--install-dir", $InstallDir, "--node", $useNode
    )
    if ($LASTEXITCODE -ne 0) { throw "assemble failed (exit code $LASTEXITCODE)" }
}

$info = Get-Content -Path (Join-Path $repo ".build\portable-info.json") -Raw | ConvertFrom-Json
if (-not (Test-Path (Join-Path $info.dir "agent\zcode.cjs"))) { throw "Assembled portable not found: $($info.dir)" }

# --- Install side-by-side and repoint the launcher.
$bin = Join-Path $InstallDir "bin"
$versions = Join-Path $InstallDir "versions"
$versionRoot = Join-Path $versions $info.versionId
$package = Join-Path $versionRoot "ZCode-CLI-Portable"
New-Item -ItemType Directory -Force $versions, $bin | Out-Null
if (Test-Path $versionRoot) { Remove-Item -Recurse -Force $versionRoot }
New-Item -ItemType Directory -Force $versionRoot | Out-Null
# robocopy instead of Copy-Item: the package contains paths close to the 260-character limit that
# PowerShell 5.1 cannot handle. Its exit codes below 8 mean success.
Invoke-External robocopy @($info.dir, $package, "/E", "/XJ", "/R:2", "/W:2", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
if ($LASTEXITCODE -ge 8) { throw "copying the portable package failed (robocopy exit code $LASTEXITCODE)" }
# UTF-8 without BOM: the launcher reads this file after `chcp 65001`, ANSI would break Cyrillic paths.
[IO.File]::WriteAllText((Join-Path $InstallDir "source-repo.txt"), $repo, (New-Object Text.UTF8Encoding $false))
Copy-Item -Path (Join-Path $repo "scripts\zcode-launcher.cmd") -Destination (Join-Path $bin "zcode.cmd") -Force
# The shell wrapper for Git Bash needs LF line endings, whatever the checkout has.
$wrapper = [IO.File]::ReadAllText((Join-Path $repo "scripts\zcode")) -replace "`r?`n", "`n"
[IO.File]::WriteAllText((Join-Path $bin "zcode"), $wrapper, (New-Object Text.UTF8Encoding $false))

# --- Prove that the install works.
$launcher = Join-Path $bin "zcode.cmd"
$version = [string](Invoke-External (Join-Path $package "zcode.cmd") @("--version"))
if ($LASTEXITCODE -ne 0 -or -not $version.Trim()) { throw "The installed CLI does not start (exit code $LASTEXITCODE)" }

# --- Make `zcode` reachable.
if ($NoPathUpdate) {
    Write-Host "   PATH was not changed (-NoPathUpdate): start the launcher by its full path"
} elseif (Add-UserPathEntry $bin) {
    Write-Host "   Added to user PATH: $bin"
}
$env:PATH = "$env:PATH;$bin"
$first = (Get-Command zcode -ErrorAction SilentlyContinue | Select-Object -First 1).Source

# --- The launcher always starts the newest version, the older ones are only disk space. A version
# that a running zcode window was started from is left alone until the window is closed: its files
# are not locked, but the window keeps loading from that folder. Nothing is deleted when the
# running processes cannot be listed.
if ($KeepVersions -gt 0) {
    $running = $null
    try { $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { $_.ExecutablePath }) } catch { }
    if ($null -ne $running) {
        Get-ChildItem $versions -Directory | Sort-Object Name -Descending | Select-Object -Skip $KeepVersions | ForEach-Object {
            $old = $_.FullName + "\"
            $inUse = $running | Where-Object { $_ -and $_.StartsWith($old, [StringComparison]::OrdinalIgnoreCase) }
            if (-not $inUse) { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
        }
    }
}

Write-Host ""
Write-Host "== Installed zcode $version ($($info.versionId))"
Write-Host "   launcher : $launcher"
Write-Host "   source   : $repo   (kept for the daily update check)"
if ($first -and $first -ine $launcher) { Write-Warning "another 'zcode' comes first on PATH: $first" }
if (-not $NoPathUpdate) {
    Write-Host "   Open a NEW terminal window and run: zcode"
    Write-Host "   Windows that were already open keep the old PATH: restart them,"
    Write-Host "   or start the launcher by its full path for now."
}
exit 0
