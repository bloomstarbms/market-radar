@echo off
title Market Radar - autostart installer
cd /d "%~dp0"
if exist "%~dp0MIGRATED-TO-VPS" (
  echo REFUSED: Market Radar moved to the VPS on 2026-09-25 - this desktop tree is not the runtime.
  echo Read MIGRATED-TO-VPS in this folder. Two instances double-post and fight over getUpdates.
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org first.
  pause & exit /b 1
)
echo Set shell = CreateObject("WScript.Shell") > "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\market-radar.vbs"
echo shell.Run """%~dp0run-hidden.vbs""", 0, False >> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\market-radar.vbs"
echo.
echo Done! Market Radar will now start automatically every time you log in.
echo (If the bot is not currently running, double-click RESTART-BOT.bat to start it.)
timeout /t 5 >nul
