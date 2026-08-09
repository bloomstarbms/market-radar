@echo off
title Market Radar - remove autostart
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\market-radar.vbs" 2>nul
taskkill /f /im node.exe /fi "WINDOWTITLE eq *" >nul 2>nul
echo Autostart removed. To stop a currently running bot, restart the PC
echo or end node.exe in Task Manager.
pause
