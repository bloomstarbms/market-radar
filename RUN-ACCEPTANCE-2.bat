@echo off
cd /d "%~dp0"
node acceptance-test-2.js > acceptance2-result.txt 2>&1
type acceptance2-result.txt
timeout /t 4 >nul
