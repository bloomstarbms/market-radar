@echo off
cd /d "%~dp0"
REM APPEND-ONLY: never rewrites .env, so it cannot truncate existing keys.
powershell -NoProfile -Command "$k=(Get-Clipboard).Trim(); if($k -like 'eyJ*' -and $k.Length -gt 100){ if((Get-Content .env -Raw) -notmatch 'MORALIS_API_KEY='){ Add-Content .env ('MORALIS_API_KEY=' + $k); 'APPENDED len=' + $k.Length | Out-File moralis-result.txt -Encoding utf8 } else { 'ALREADY PRESENT - not touched' | Out-File moralis-result.txt -Encoding utf8 } } else { 'CLIPBOARD NOT A MORALIS JWT (len=' + $k.Length + ')' | Out-File moralis-result.txt -Encoding utf8 }"
