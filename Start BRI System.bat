@echo off
title BRI'S CUISINE - Offline Management System
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run the automatic JSON database launcher.
  echo You can still open index.html directly in a browser.
  echo.
  pause
  exit /b 1
)
node server.js
if errorlevel 1 (
  echo.
  echo The launcher stopped because of an error.
  pause
)
