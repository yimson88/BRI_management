@echo off
title Build BRI'S CUISINE Installer
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0desktop\Build-Installer.ps1"
if errorlevel 1 (
  echo.
  echo The installer build failed.
) else (
  echo.
  echo Installer build completed successfully.
)
pause
