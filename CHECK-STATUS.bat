@echo off
cd /d "%~dp0"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ((($_.Name -eq 'node.exe') -and ($_.CommandLine -match 'index\.js')) -or ($_.CommandLine -match 'market-radar|run-hidden')) -and $_.CommandLine -notmatch 'CHECK-STATUS' } | ForEach-Object { \"$($_.ProcessId) $($_.Name) :: $($_.CommandLine)\" } | Out-File status.txt -Encoding utf8"
findstr "VERSION" src\config.js >> status.txt
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\market-radar.vbs" (echo AUTOSTART: INSTALLED >> status.txt) else (echo AUTOSTART: MISSING >> status.txt)
copy /y data\bot.log data\bot-snapshot.log >nul 2>nul
powershell -NoProfile -Command "Get-Content data\bot-snapshot.log -Tail 25 | Out-File -Append status.txt -Encoding utf8"
