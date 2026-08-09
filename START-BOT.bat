@echo off
title Market Radar
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed. Download it from https://nodejs.org
  echo  ^(choose the LTS version^), install, then double-click this file again.
  echo.
  pause
  exit /b 1
)
echo Starting Market Radar... keep this window open to stay subscribed to alerts.
echo Press Ctrl+C to stop.
echo.
node src\index.js
pause
