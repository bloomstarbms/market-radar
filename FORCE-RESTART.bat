@echo off
title Market Radar - FORCE restart
cd /d "%~dp0"
if exist "%~dp0MIGRATED-TO-VPS" (
  echo REFUSED: Market Radar moved to the VPS on 2026-09-25 - this desktop tree is not the runtime.
  echo Read MIGRATED-TO-VPS in this folder. Two instances double-post and fight over getUpdates.
  exit /b 1
)
echo Killing ALL node processes and radar loops...
taskkill /f /im node.exe >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'run-hidden' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
timeout /t 4 /nobreak >nul
echo Starting one fresh instance...
wscript "%~dp0run-hidden.vbs"
echo Done.
timeout /t 4 >nul
