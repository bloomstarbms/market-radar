@echo off
cd /d "%~dp0"
if exist "%~dp0MIGRATED-TO-VPS" (
  echo REFUSED: Market Radar moved to the VPS on 2026-09-25 - this desktop tree is not the runtime.
  echo Read MIGRATED-TO-VPS in this folder. Two instances double-post and fight over getUpdates.
  exit /b 1
)
:loop
node src\index.js >> data\bot.log 2>&1
echo [%date% %time%] bot exited, restarting in 15s... >> data\bot.log
timeout /t 15 /nobreak >nul
goto loop
