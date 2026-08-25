@echo off
cd /d "%~dp0"
echo === POWER SETUP %date% %time% === > power-report.txt
echo --- sleep states available --- >> power-report.txt
powercfg /a >> power-report.txt 2>&1
echo --- disabling sleep+hibernate on AC (0 = never) --- >> power-report.txt
powercfg /change standby-timeout-ac 0 >> power-report.txt 2>&1
powercfg /change hibernate-timeout-ac 0 >> power-report.txt 2>&1
echo --- wake timer policy (RTCWAKE: 0=disabled 1=enabled) --- >> power-report.txt
powercfg /query SCHEME_CURRENT SUB_SLEEP RTCWAKE >> power-report.txt 2>&1
echo --- last 20 sleep/resume events (Power-Troubleshooter 1 = sleep time + wake time) --- >> power-report.txt
wevtutil qe System "/q:*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and (EventID=1)]]" /c:20 /rd:true /f:text >> power-report.txt 2>&1
echo --- last 30 boot/shutdown events (Kernel-General 12=boot 13=shutdown) --- >> power-report.txt
wevtutil qe System "/q:*[System[Provider[@Name='Microsoft-Windows-Kernel-General'] and (EventID=12 or EventID=13)]]" /c:30 /rd:true /f:text >> power-report.txt 2>&1
echo --- autostart entries --- >> power-report.txt
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" >> power-report.txt 2>&1
dir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup" >> power-report.txt 2>&1
echo DONE >> power-report.txt
