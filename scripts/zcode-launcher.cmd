@echo off
rem ZCode CLI launcher with a once-per-day self-update check.
rem Layout: <root>\bin\zcode.cmd (this file), <root>\versions\<id>\ZCode-CLI-Portable, <root>\source-repo.txt
setlocal EnableExtensions DisableDelayedExpansion
set "ROOT=%~dp0.."

rem The console code page is switched to 65001 for the update check (Russian UTF-8 text) and
rem put back before the CLI starts: the console must not stay changed after zcode exits.
rem (a period is a delimiter too: some locales end the line of chcp with one)
set "OLDCP="
for /f "tokens=2 delims=:." %%C in ('chcp') do set "OLDCP=%%C"
chcp 65001 >nul

rem Find the newest installed version and its bundled node.
set "NODE=" & set "LATEST="
for /f "delims=" %%D in ('dir /b /ad /o-d "%ROOT%\versions" 2^>nul') do (
  if not defined LATEST if exist "%ROOT%\versions\%%D\ZCode-CLI-Portable\runtime\node.exe" (
    set "LATEST=%ROOT%\versions\%%D\ZCode-CLI-Portable"
    set "NODE=%ROOT%\versions\%%D\ZCode-CLI-Portable\runtime\node.exe"
  )
)

rem Self-update check (silent unless updates exist).
rem Commands that only print and exit get no update check in front of them. The first eight arguments
rem are looked at. Each one is copied into A and stripped of its quotes first: a quote or a ")" in
rem the argument text itself would break the comparison. "?" stands for a missing argument.
set "FLAGS=-p --prompt --version -v --help -h app-server version doctor"
set "SKIP="
set "A=%~1" & if not defined A set "A=?"
set "A=%A:"=%"
for %%F in (%FLAGS%) do if /i "%A%"=="%%~F" set "SKIP=1"
set "A=%~2" & if not defined A set "A=?"
set "A=%A:"=%"
for %%F in (%FLAGS%) do if /i "%A%"=="%%~F" set "SKIP=1"
set "A=%~3" & if not defined A set "A=?"
set "A=%A:"=%"
for %%F in (%FLAGS%) do if /i "%A%"=="%%~F" set "SKIP=1"
set "A=%~4" & if not defined A set "A=?"
set "A=%A:"=%"
for %%F in (%FLAGS%) do if /i "%A%"=="%%~F" set "SKIP=1"
set "A=%~5" & if not defined A set "A=?"
set "A=%A:"=%"
for %%F in (%FLAGS%) do if /i "%A%"=="%%~F" set "SKIP=1"
set "A=%~6" & if not defined A set "A=?"
set "A=%A:"=%"
for %%F in (%FLAGS%) do if /i "%A%"=="%%~F" set "SKIP=1"
set "A=%~7" & if not defined A set "A=?"
set "A=%A:"=%"
for %%F in (%FLAGS%) do if /i "%A%"=="%%~F" set "SKIP=1"
set "A=%~8" & if not defined A set "A=?"
set "A=%A:"=%"
for %%F in (%FLAGS%) do if /i "%A%"=="%%~F" set "SKIP=1"
rem for /f gives a runtime value (%%R): %SRCPATH%-style parsing would expand at parse time.
if not defined SKIP if defined NODE if exist "%ROOT%\source-repo.txt" (
  for /f "usebackq delims=" %%R in ("%ROOT%\source-repo.txt") do (
    if exist "%%R\scripts\install.ps1" if exist "%LATEST%\agent\check-update.mjs" (
      "%NODE%" "%LATEST%\agent\check-update.mjs" --repo "%%R" --install-dir "%ROOT%"
    )
  )
)
if defined OLDCP chcp %OLDCP% >nul

rem Re-resolve the newest version: the check above may have installed a newer one.
set "LATEST="
for /f "delims=" %%D in ('dir /b /ad /o-d "%ROOT%\versions" 2^>nul') do (
  if not defined LATEST if exist "%ROOT%\versions\%%D\ZCode-CLI-Portable\zcode.cmd" set "LATEST=%ROOT%\versions\%%D\ZCode-CLI-Portable"
)
if not defined LATEST (
  echo No installed ZCode version found under "%ROOT%\versions"
  exit /b 1
)

rem No `call` here: it would parse the arguments a second time and eat every "%" in them.
"%LATEST%\zcode.cmd" %*
