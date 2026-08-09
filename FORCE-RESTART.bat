@echo off
title Market Radar - FORCE restart
cd /d "%~dp0"
echo Killing ALL node processes and radar loops...
taskkill /f /im node.exe >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'run-hidden' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
timeout /t 4 /nobreak >nul
echo Starting one fresh instance...
wscript "%~dp0run-hidden.vbs"
echo Done.
timeout /t 4 >nul
