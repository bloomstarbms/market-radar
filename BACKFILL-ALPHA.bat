@echo off
title Market Radar - alpha backfill
cd /d "%~dp0"
echo Stopping the bot so it cannot overwrite outcomes.json mid-repair...
taskkill /f /im node.exe >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'run-hidden' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
timeout /t 4 /nobreak >nul
echo.
echo === DRY RUN ===
node backfill-alpha.js > backfill-result.txt 2>&1
echo.
echo === APPLYING ===
node backfill-alpha.js --write >> backfill-result.txt 2>&1
type backfill-result.txt
echo.
echo Restarting the bot...
wscript "%~dp0run-hidden.vbs"
echo Done. Results saved to backfill-result.txt
timeout /t 6 >nul
