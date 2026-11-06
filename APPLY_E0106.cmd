@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0apply_fix.ps1"
if errorlevel 1 (
  echo.
  echo Patch did not complete. See the message above.
  pause
  exit /b 1
)
echo.
echo You can now run BUILD_WINDOWS_TAURI.cmd in your project folder.
pause
