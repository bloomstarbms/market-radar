@echo off
title Market Radar - restart
cd /d "%~dp0"
if exist "%~dp0MIGRATED-TO-VPS" (
  echo REFUSED: Market Radar moved to the VPS on 2026-09-25 - this desktop tree is not the runtime.
  echo Read MIGRATED-TO-VPS in this folder. Two instances double-post and fight over getUpdates.
  exit /b 1
)
echo Stopping ALL Market Radar processes (bot instances + restart loops)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (($_.Name -eq 'node.exe') -and ($_.CommandLine -match 'index\.js')) -or (($_.Name -eq 'cmd.exe') -and ($_.CommandLine -match 'run-hidden|market-radar') -and ($_.CommandLine -notmatch 'RESTART-BOT')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
timeout /t 3 /nobreak >nul
echo Starting one fresh instance (hidden, logs to data\bot.log)...
wscript "%~dp0run-hidden.vbs"
echo Done. Exactly one Market Radar running with the latest code.
timeout /t 4 >nul
