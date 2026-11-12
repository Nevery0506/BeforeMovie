@echo off
setlocal
cd /d "%~dp0"
title PreShow setup
set "PS_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "PS_ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "PS_ARCH=arm64"
rem  "SETUP_FIRST.bat all" downloads the files for both PC types (x64 and ARM64).
set "PS_WANT=%PS_ARCH%"
if /i "%~1"=="all" set "PS_WANT=all"
if /i "%~1"=="x64" set "PS_WANT=x64"
if /i "%~1"=="arm64" set "PS_WANT=arm64"

echo.
echo  PreShow - first-time setup (internet needed)
echo  This PC: %PS_ARCH%    Downloading for: %PS_WANT%   (about 350 MB per PC type)
echo.
where curl >nul 2>nul
if errorlevel 1 goto :nocurl
if not exist "runtime" mkdir "runtime"

if "%PS_WANT%"=="arm64" goto :arm
call :getset "" "win32-x64" "yt-dlp.exe" "win64"
if errorlevel 1 goto :fail
if "%PS_WANT%"=="x64" goto :done

:arm
call :getset "-arm64" "win32-arm64" "yt-dlp_arm64.exe" "winarm64"
if errorlevel 1 goto :fail

:done
echo.
echo  Setup finished. Run START.bat to open PreShow.
echo.
pause
exit /b 0

:nocurl
echo  This PC has no "curl" command (needs Windows 10 version 1803 or newer).
pause
exit /b 1

:fail
echo.
echo  Download failed. Check the internet connection and run this file again.
echo.
pause
exit /b 1

rem ---- getset <folder suffix> <electron name> <yt-dlp file> <ffmpeg name> ----
:getset
set "SFX=%~1"
if not exist "runtime\electron%SFX%" mkdir "runtime\electron%SFX%"
if not exist "runtime\bin%SFX%" mkdir "runtime\bin%SFX%"

if exist "runtime\electron%SFX%\electron.exe" goto :gs2
echo  [%~2] Downloading the app engine...
curl -L --fail --retry 3 -o "runtime\electron%SFX%.zip" "https://github.com/electron/electron/releases/download/v45.3.0/electron-v45.3.0-%~2.zip"
if errorlevel 1 exit /b 1
tar -xf "runtime\electron%SFX%.zip" -C "runtime\electron%SFX%"
if errorlevel 1 exit /b 1
del "runtime\electron%SFX%.zip"

:gs2
if exist "runtime\bin%SFX%\yt-dlp.exe" goto :gs3
echo  [%~2] Downloading the trailer download tool (yt-dlp)...
curl -L --fail --retry 3 -o "runtime\bin%SFX%\yt-dlp.exe" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/%~3"
if errorlevel 1 exit /b 1

:gs3
if exist "runtime\bin%SFX%\ffmpeg.exe" exit /b 0
echo  [%~2] Downloading the video tool (ffmpeg)...
curl -L --fail --retry 3 -o "runtime\ffmpeg%SFX%.zip" "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-%~4-gpl.zip"
if errorlevel 1 exit /b 1
tar -xf "runtime\ffmpeg%SFX%.zip" -C "runtime\bin%SFX%" --strip-components=2 "ffmpeg-master-latest-%~4-gpl/bin/ffmpeg.exe"
if errorlevel 1 exit /b 1
del "runtime\ffmpeg%SFX%.zip"
exit /b 0
