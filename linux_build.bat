@echo off
dotnet publish VRCNext.csproj ^
  -c Release ^
  -r linux-x64 ^
  --self-contained true ^
  -o publish\linux ^
  /p:PublishSingleFile=true ^
  /p:IncludeNativeLibrariesForSelfExtract=true

if errorlevel 1 (
  echo.
  echo Build FAILED.
  pause
  exit /b 1
)

if exist install_vrcnext.sh (
  if not exist publish\linux mkdir publish\linux
  powershell -NoProfile -Command "(Get-Content install_vrcnext.sh -Raw) -replace \"`r`n\",\"`n\" | Set-Content -NoNewline publish\linux\install_vrcnext.sh"
) else (
  echo WARNING: install_vrcnext.sh not found, skipping copy.
)

echo.
echo Linux build complete: publish\linux\
echo   VRCNext              - main binary
echo   install_vrcnext.sh   - run on Linux to install deps + register app
pause
