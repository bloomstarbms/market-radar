@echo off
cd /d "%~dp0"
node gen-wake-timers.js > wake-result.txt 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File wake-timers.ps1 >> wake-result.txt 2>&1
echo DONE >> wake-result.txt
