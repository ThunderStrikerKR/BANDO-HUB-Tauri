@echo off
setlocal
cd /d "%~dp0"
echo ==============================================
echo BANDO HUB Tauri v0.0.4 - Excel TS2345 fix
echo ==============================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0apply_fix.ps1"
if errorlevel 1 (
  echo.
  echo PATCH FAILED. Please send a screenshot of the error.
  pause
  exit /b 1
)
echo.
echo Patch finished. Run BUILD_WINDOWS_TAURI.cmd from your source folder.
pause
