@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File wake-selftest.ps1 > wake-selftest.txt 2>&1
echo DONE >> wake-selftest.txt
