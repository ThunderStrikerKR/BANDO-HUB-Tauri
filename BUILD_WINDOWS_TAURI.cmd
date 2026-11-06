@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
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
echo [4/4] Copying executable...
if not exist "src-tauri\target\release\bando_hub_tauri.exe" goto failed
if not exist release mkdir release
copy /Y "src-tauri\target\release\bando_hub_tauri.exe" "release\BANDO-HUB-v0.0.4.exe" >nul
if errorlevel 1 goto failed
echo.
echo SUCCESS: release\BANDO-HUB-v0.0.4.exe
echo.
pause
exit /b 0
:missing_node
echo ERROR: Node.js/npm not installed or missing from PATH.
goto failed
:missing_rust
echo ERROR: Rust cargo not installed or missing from PATH.
goto failed
:failed
echo.
echo BUILD FAILED. Please capture the error above and send a screenshot.
pause
exit /b 1
