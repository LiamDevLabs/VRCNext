@echo off
title VRCNext - Publish Build
cd /d "%~dp0"

echo.
echo  ================================
echo   VRCNext - Release Publish Build
echo  ================================
echo.

dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=false

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [ERROR] Build failed! See output above.
    echo.
    pause
    exit /b 1
)

echo.
echo  [OK] Build successful!
echo.

set OUT=bin\Release\net8.0-windows10.0.22621.0\win-x64\publish

echo  Output: %~dp0%OUT%
echo.

explorer "%~dp0%OUT%"
