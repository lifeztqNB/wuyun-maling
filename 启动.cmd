@echo off
setlocal

rem ============================================================================
rem  Wuyun MaLing (雾韵码灵) launcher  --  Windows
rem
rem  NOTE: keep this file ASCII-only on purpose. cmd.exe reads .bat files using
rem  the active code page, and mixing a "chcp 65001" with UTF-8 Chinese text in
rem  the same file garbles the output on many systems. Chinese docs live in
rem  README.md instead.
rem ============================================================================

rem  Electron treats ELECTRON_RUN_AS_NODE=1 as "run me as a plain Node process".
rem  When that happens the main process has no `app` / `BrowserWindow` and dies
rem  with a confusing "Cannot read properties of undefined (reading 'setPath')".
rem  Several dev toolchains export this globally, so clear it defensively.
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

set "APP_DIR=%~dp0"
set "EXE=%APP_DIR%node_modules\electron\dist\electron.exe"

if not exist "%EXE%" goto install
goto run

:install
echo.
echo   First run: installing dependencies (~100 MB, this may take a while)...
echo.
pushd "%APP_DIR%"
call npm install
popd
if not exist "%EXE%" (
  echo.
  echo   Install failed. Make sure Node.js 18+ is installed and npm is reachable.
  echo.
  pause
  exit /b 1
)

:run
start "Wuyun MaLing" "%EXE%" "%APP_DIR%."
exit /b 0
