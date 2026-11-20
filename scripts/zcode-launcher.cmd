@echo off
rem ZCode CLI launcher with a once-per-day self-update check.
rem Layout: <root>\bin\zcode.cmd (this file), <root>\versions\<id>\ZCode-CLI-Portable, <root>\source-repo.txt
rem chcp 65001 first: the update check prints Russian UTF-8 text.
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
set "ROOT=%~dp0.."

rem Find the newest installed version and its bundled node.
set "NODE=" & set "LATEST="
for /f "delims=" %%D in ('dir /b /ad /o-d "%ROOT%\versions" 2^>nul') do (
  if not defined LATEST if exist "%ROOT%\versions\%%D\ZCode-CLI-Portable\runtime\node.exe" (
    set "LATEST=%ROOT%\versions\%%D\ZCode-CLI-Portable"
    set "NODE=%ROOT%\versions\%%D\ZCode-CLI-Portable\runtime\node.exe"
  )
)

rem Self-update check (silent unless updates exist).
rem for /f gives a runtime value (%%R): %SRCPATH%-style parsing would expand at parse time.
if defined NODE if exist "%ROOT%\source-repo.txt" (
  for /f "usebackq delims=" %%R in ("%ROOT%\source-repo.txt") do (
    if exist "%%R\scripts\install.ps1" if exist "%LATEST%\agent\check-update.mjs" (
      "%NODE%" "%LATEST%\agent\check-update.mjs" --repo "%%R" --install-dir "%ROOT%"
    )
  )
)

rem Re-resolve the newest version: the check above may have installed a newer one.
set "LATEST="
for /f "delims=" %%D in ('dir /b /ad /o-d "%ROOT%\versions" 2^>nul') do (
  if not defined LATEST if exist "%ROOT%\versions\%%D\ZCode-CLI-Portable\zcode.cmd" set "LATEST=%ROOT%\versions\%%D\ZCode-CLI-Portable"
)
if not defined LATEST (
  echo No installed ZCode version found under "%ROOT%\versions"
  exit /b 1
)
call "%LATEST%\zcode.cmd" %*
exit /b %errorlevel%
