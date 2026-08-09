@echo off
cd /d "%~dp0"
:loop
node src\index.js >> data\bot.log 2>&1
echo [%date% %time%] bot exited, restarting in 15s... >> data\bot.log
timeout /t 15 /nobreak >nul
goto loop
