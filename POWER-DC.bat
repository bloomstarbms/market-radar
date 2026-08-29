@echo off
cd /d "%~dp0"
echo === DC power fix %date% %time% === > power-dc-result.txt
echo The Aug 23-24 26h outage was a BATTERY sleep: sleep-never was AC-only. >> power-dc-result.txt
powercfg /change standby-timeout-dc 0 >> power-dc-result.txt 2>&1
powercfg /change hibernate-timeout-dc 0 >> power-dc-result.txt 2>&1
echo --- verify (both AC and DC should now be 0) --- >> power-dc-result.txt
powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE >> power-dc-result.txt 2>&1
echo DONE >> power-dc-result.txt
