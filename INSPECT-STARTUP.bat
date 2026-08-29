@echo off
cd /d "%~dp0"
echo === startup inspection %date% %time% === > startup-inspect.txt
echo. >> startup-inspect.txt
echo --- start-bot-on-boot.vbs (provenance unknown, 25/08 05:52) --- >> startup-inspect.txt
type "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\start-bot-on-boot.vbs" >> startup-inspect.txt 2>&1
echo. >> startup-inspect.txt
echo --- market-radar.vbs (ours, 17/07) --- >> startup-inspect.txt
type "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\market-radar.vbs" >> startup-inspect.txt 2>&1
echo. >> startup-inspect.txt
echo --- last boot time (has the machine rebooted since 25/08 05:52?) --- >> startup-inspect.txt
powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime" >> startup-inspect.txt 2>&1
echo DONE >> startup-inspect.txt
