# ZCode CLI for Windows: install, update, uninstall

The scripts in this folder build the terminal CLI of this fork on the machine that runs it and keep
it up to date. Nothing has to be downloaded by hand.

## Requirements

- Windows 10 or 11 with Windows PowerShell 5.1, which is part of the system
- Git for Windows: `winget install --id Git.Git -e`, then open a new terminal window
- About 8 GB of free disk space: the source checkout (6 GB) and the installed CLI (220 MB per version)

## Install

One line in PowerShell:

```powershell
irm https://raw.githubusercontent.com/lemur-galago/ZCode/main/scripts/install.ps1 | iex
```

Or from a saved copy of [install.ps1](install.ps1):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

What happens:

1. The fork is cloned to `%LOCALAPPDATA%\ZCodeCLI-src` (the first time only).
2. Node.js 24 is downloaded from nodejs.org and checked against its SHA-256 checksum, the
   dependencies are installed and the CLI is built. The first install takes about 20 minutes.
3. The build is installed side by side into
   `%LOCALAPPDATA%\Programs\ZCodeCLI\versions\<date>-<commit>`, and the launcher `bin\zcode.cmd`
   is pointed at it. The installed CLI is started once to prove that it works.
4. `%LOCALAPPDATA%\Programs\ZCodeCLI\bin` is added to the user PATH.

Open a **new** terminal window and run `zcode`. Windows that were already open keep the old PATH.
In Git Bash the command is `zcode` as well: a small shell wrapper is installed next to `zcode.cmd`.

### Options

| Option | Meaning |
| --- | --- |
| `-InstallDir <dir>` | Install root. Default `%LOCALAPPDATA%\Programs\ZCodeCLI` |
| `-SourceDir <dir>` | Where the source checkout lives. Default `%LOCALAPPDATA%\ZCodeCLI-src` |
| `-NodeVersion <x.y.z>` | Node.js used for the build and shipped as the runtime. Default `24.14.0` |
| `-KeepVersions <n>` | Installed versions to keep. Older ones are deleted after an install. Default `3`, `0` keeps all |
| `-NoPathUpdate` | Leave the user PATH alone |
| `-SkipBuild` | The tree is already built and assembled (`.build\portable-info.json` exists): only install |
| `-Uninstall` | Remove the install folder and the PATH entry. The source checkout stays |

A version that an open zcode window was started from is never deleted or replaced: it goes at the
next install after that window is closed.

## Update

`zcode` checks the fork once a day, before it starts. When there are new commits it lists them and
asks `Установить сейчас? [y/N]` ("install now?"):

- `y` pulls the sources, builds and installs the new version (several minutes), then starts it.
- `n` or Enter starts the current version; the question comes back the next day.

Commands that only print and exit (`--version`, `--help`, `-p`, `app-server`, `doctor`) never wait
for the check. Without a terminal on stdin (scripts, `zcode -p`) nothing is asked: one line goes to
stderr instead, and the next start from a terminal asks.

Offline, the check gives up after 10 seconds and is not tried again for an hour.

To update by hand:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\ZCodeCLI-src\scripts\install.ps1"
```

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\ZCodeCLI-src\scripts\install.ps1" -Uninstall
```

Delete `%LOCALAPPDATA%\ZCodeCLI-src` by hand when you no longer need the sources.

## Files

| File | Role |
| --- | --- |
| [install.ps1](install.ps1) | Installs and updates: toolchain, build, side-by-side install, PATH |
| [zcode-launcher.cmd](zcode-launcher.cmd) | Installed as `bin\zcode.cmd`. Finds the newest version, runs the update check, starts the CLI |
| [zcode](zcode) | Shell wrapper for Git Bash, installed as `bin\zcode` |
| [check-update.mjs](check-update.mjs) | The daily update check. Copied into every installed version |
| [assemble-portable.mjs](assemble-portable.mjs) | Packs a built tree into the portable folder `ZCode-CLI-Portable` |

The CLI shares the `~\.zcode` storage with the ZCode desktop app.
