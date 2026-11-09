@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem Keep the existing release usable until BOTH the EXE and bundled OCR are ready.
echo [0/5] Checking whether BANDO HUB is running...
call :ensure_bando_closed
if errorlevel 1 goto app_running

echo [1/5] Node.js, Rust and PowerShell check...
where npm >nul 2>nul
if errorlevel 1 goto missing_node
where cargo >nul 2>nul
if errorlevel 1 goto missing_rust
where powershell >nul 2>nul
if errorlevel 1 goto failed

echo [2/5] JavaScript dependency install...
call npm install --no-audit --no-fund
if errorlevel 1 goto failed

echo [3/5] Tauri standalone build...
call npm run build:windows
if errorlevel 1 goto failed

echo [4/5] Creating the self-contained OCR folder...
if not exist "release" mkdir "release"
if errorlevel 1 goto copy_failed
if exist "release\ocr.next" rmdir /S /Q "release\ocr.next"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\package-ocr-runtime.ps1" -TargetDir "release\ocr.next"
if errorlevel 1 goto ocr_failed
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\verify-packaged-ocr.ps1" -OcrRoot "release\ocr.next"
if errorlevel 1 goto ocr_failed

echo [5/5] Staging and publishing the EXE and OCR together...
if not exist "src-tauri\target\release\bando_hub_tauri.exe" goto failed
copy /Y "src-tauri\target\release\bando_hub_tauri.exe" "release\bando_hub.exe.pending" >nul
if errorlevel 1 goto copy_failed

rem Never change the published version if it was started during compilation.
call :ensure_bando_closed
if errorlevel 1 goto app_running_after_build

rem Keep the existing OCR directory until the new one is staged.
if exist "release\ocr.previous" goto previous_leftover
if exist "release\ocr" (
  move "release\ocr" "release\ocr.previous" >nul
  if errorlevel 1 goto copy_failed
)
move "release\ocr.next" "release\ocr" >nul
if errorlevel 1 goto ocr_rollback
move /Y "release\bando_hub.exe.pending" "release\bando_hub.exe" >nul
if errorlevel 1 goto ocr_rollback
if exist "release\ocr.previous" rmdir /S /Q "release\ocr.previous"

rem A distributable ZIP contains the EXE and the complete private OCR runtime.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -LiteralPath 'release\bando_hub.exe','release\ocr' -DestinationPath 'release\BANDO-HUB-portable.next.zip' -Force"
if errorlevel 1 goto zip_failed
move /Y "release\BANDO-HUB-portable.next.zip" "release\BANDO-HUB-portable.zip" >nul
if errorlevel 1 goto zip_failed

rem Old numbered release EXEs are only removed after the new version succeeded.
if exist "release\BANDO-HUB-v*.exe" del /Q "release\BANDO-HUB-v*.exe" >nul 2>nul

echo.
echo SUCCESS: release\bando_hub.exe + release\ocr
echo PORTABLE ZIP: release\BANDO-HUB-portable.zip
echo Python installation on staff computers is NOT required.
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
echo Close the program normally and retry. Existing release\bando_hub.exe was not changed.
pause
exit /b 2

:app_running_after_build
if exist "release\bando_hub.exe.pending" del /Q "release\bando_hub.exe.pending" >nul 2>nul
if exist "release\ocr.next" rmdir /S /Q "release\ocr.next"
echo.
echo BUILD SUCCEEDED, but BANDO HUB was started during compilation.
echo Existing release\bando_hub.exe was not changed.
pause
exit /b 2

:previous_leftover
echo OCR backup directory from a previous interrupted publish exists.
echo Please inspect release\ocr.previous before rerunning the build.
goto copy_failed

:ocr_rollback
if exist "release\ocr.previous" (
  if exist "release\ocr" rmdir /S /Q "release\ocr"
  move "release\ocr.previous" "release\ocr" >nul
)
goto copy_failed

:ocr_failed
echo.
echo OCR packaging failed. The existing release\bando_hub.exe and OCR folder were not replaced.
pause
exit /b 1

:zip_failed
echo.
echo BANDO HUB and OCR were published, but portable ZIP creation failed.
echo You can still copy release\bando_hub.exe together with the release\ocr folder.
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
echo PUBLISH FAILED. Existing release\bando_hub.exe was not changed.
pause
exit /b 2

:failed
echo.
echo BUILD FAILED. Capture the error above and send a screenshot.
pause
exit /b 1
