@echo off
setlocal
cd /d "%~dp0"
echo ===========================================
echo BANDO HUB Tauri v0.0.3 - Rust fix
echo E0106 + E0308 automatic source patch
 echo ===========================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0apply_fix.ps1"
if errorlevel 1 (
  echo.
  echo PATCH FAILED. Take a screenshot of the error above.
  pause
  exit /b 1
)
echo.
echo Patch complete. Run BUILD_WINDOWS_TAURI.cmd in your project folder.
pause
