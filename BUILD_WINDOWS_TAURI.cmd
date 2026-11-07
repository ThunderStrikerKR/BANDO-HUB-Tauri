@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem Do not run a long compilation if the published EXE is already in use.
rem Also reject a running Rust build output (bando_hub_tauri.exe).
echo [0/4] Checking whether BANDO HUB is running...
call :ensure_bando_closed
if errorlevel 1 goto app_running

echo [1/4] Node.js and Rust check...
where npm >nul 2>nul
if errorlevel 1 goto missing_node
where cargo >nul 2>nul
if errorlevel 1 goto missing_rust

echo [2/4] JavaScript dependency install...
call npm install --no-audit --no-fund
if errorlevel 1 goto failed

echo [3/4] Tauri standalone build (no extraction/installer)...
call npm run build:windows
if errorlevel 1 goto failed

echo [4/4] Updating release\bando_hub.exe...
if not exist "src-tauri\target\release\bando_hub_tauri.exe" goto failed
if not exist "release" mkdir "release"
if errorlevel 1 goto copy_failed

rem Stage the complete new binary before touching the existing published EXE.
rem A failed stage copy or final rename must leave the old EXE intact.
copy /Y "src-tauri\target\release\bando_hub_tauri.exe" "release\bando_hub.exe.pending" >nul
if errorlevel 1 goto copy_failed

rem The user may have started the app during compilation. Check again.
call :ensure_bando_closed
if errorlevel 1 goto app_running_after_build

move /Y "release\bando_hub.exe.pending" "release\bando_hub.exe" >nul
if errorlevel 1 goto copy_failed

rem Only remove old version-numbered release EXEs after successful replacement.
if exist "release\BANDO-HUB-v*.exe" del /Q "release\BANDO-HUB-v*.exe" >nul 2>nul
if exist "release\BANDO-HUB-v*.exe" (
    echo WARNING: Old versioned EXE could not be removed. Close it and delete it manually.
)

echo.
echo SUCCESS: release\bando_hub.exe
echo.
pause
exit /b 0

:ensure_bando_closed
tasklist /FI "IMAGENAME eq bando_hub.exe" /NH 2>nul | findstr /I /C:"bando_hub.exe" >nul
if not errorlevel 1 exit /b 1
tasklist /FI "IMAGENAME eq bando_hub_tauri.exe" /NH 2>nul | findstr /I /C:"bando_hub_tauri.exe" >nul
if not errorlevel 1 exit /b 1
exit /b 0

:app_running
echo.
echo BUILD NOT STARTED: BANDO HUB is still running.
echo Close the program normally and try again. No process will be terminated automatically.
echo Existing release\bando_hub.exe was not changed.
pause
exit /b 2

:app_running_after_build
if exist "release\bando_hub.exe.pending" del /Q "release\bando_hub.exe.pending" >nul 2>nul
echo.
echo BUILD SUCCEEDED, but BANDO HUB was started during compilation.
echo Close the app normally before retrying EXE replacement.
echo Compiled output: src-tauri\target\release\bando_hub_tauri.exe
echo Existing release\bando_hub.exe was not changed.
pause
exit /b 2

:missing_node
echo ERROR: Node.js/npm not installed or missing from PATH.
goto failed
:missing_rust
echo ERROR: Rust cargo not installed or missing from PATH.
goto failed
:copy_failed
if exist "release\bando_hub.exe.pending" del /Q "release\bando_hub.exe.pending" >nul 2>nul
echo.
echo BUILD SUCCEEDED, but release\bando_hub.exe could not be replaced.
echo Another process may be using the file, or the destination may be read-only.
echo Close BANDO HUB completely, then run this script again.
echo Compiled output: src-tauri\target\release\bando_hub_tauri.exe
echo Existing release\bando_hub.exe was not changed.
pause
exit /b 2
:failed
echo.
echo BUILD FAILED. Please capture the error above and send a screenshot.
pause
exit /b 1
