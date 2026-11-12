@echo off
cd /d "%~dp0"

rem ---- apply a downloaded update (made by the "update" button inside the app) ----
if not exist "update_pending\READY" goto :noupdate
echo  [PreShow] Applying update...
ping -n 3 127.0.0.1 >nul
if exist "update_pending\app" robocopy "update_pending\app" "app" /E /R:5 /W:1 /NFL /NDL /NJH /NJS /NP >nul
if exist "update_pending\remote" robocopy "update_pending\remote" "remote" /E /R:3 /W:1 /NFL /NDL /NJH /NJS /NP >nul
if exist "update_pending\README.txt" copy /y "update_pending\README.txt" "README.txt" >nul
if exist "update_pending\SETUP_FIRST.bat" copy /y "update_pending\SETUP_FIRST.bat" "SETUP_FIRST.bat" >nul
if exist "update_pending\UPDATE_TRAILER_TOOL.bat" copy /y "update_pending\UPDATE_TRAILER_TOOL.bat" "UPDATE_TRAILER_TOOL.bat" >nul
rmdir /s /q "update_pending"
:noupdate

set "PS_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "PS_ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "PS_ARCH=arm64"

rem ARM64 PC: use the native ARM64 engine when it is present, otherwise fall back to x64.
if "%PS_ARCH%"=="arm64" if exist "runtime\electron-arm64\electron.exe" goto :runarm
if exist "runtime\electron\electron.exe" goto :runx64
goto :missing

:runarm
start "" "runtime\electron-arm64\electron.exe" "app"
exit /b 0

:runx64
start "" "runtime\electron\electron.exe" "app"
exit /b 0

:missing
echo.
echo  [PreShow] Required files are missing.
echo  Please run SETUP_FIRST.bat once (internet needed), then run START.bat again.
echo.
pause
exit /b 1
