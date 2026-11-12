@echo off
cd /d "%~dp0"
set "PS_FOUND="
if exist "runtime\bin\yt-dlp.exe" set "PS_FOUND=1"
if exist "runtime\bin-arm64\yt-dlp.exe" set "PS_FOUND=1"
if not defined PS_FOUND goto :missing
echo  Updating the trailer download tool (yt-dlp)...
if exist "runtime\bin\yt-dlp.exe" "runtime\bin\yt-dlp.exe" -U
if exist "runtime\bin-arm64\yt-dlp.exe" "runtime\bin-arm64\yt-dlp.exe" -U
echo.
pause
exit /b 0

:missing
echo  yt-dlp.exe not found. Run SETUP_FIRST.bat first.
pause
exit /b 1
