@echo off
title Market Radar
cd /d "%~dp0"
if exist "%~dp0MIGRATED-TO-VPS" (
  echo REFUSED: Market Radar moved to the VPS on 2026-09-25 - this desktop tree is not the runtime.
  echo Read MIGRATED-TO-VPS in this folder. Two instances double-post and fight over getUpdates.
  exit /b 1
)
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
