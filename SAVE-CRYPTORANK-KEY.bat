@echo off
cd /d "%~dp0"
REM APPEND-ONLY: never rewrites .env, so it cannot truncate existing keys.
powershell -NoProfile -Command "$k=(Get-Clipboard).Trim(); if($k.Length -ge 40 -and $k -notmatch '\s'){ if((Get-Content .env -Raw) -notmatch 'CRYPTORANK_API_KEY='){ Add-Content .env ('CRYPTORANK_API_KEY=' + $k); 'APPENDED len=' + $k.Length | Out-File cryptorank-result.txt -Encoding utf8 } else { 'ALREADY PRESENT - not touched' | Out-File cryptorank-result.txt -Encoding utf8 } } else { 'CLIPBOARD NOT A KEY (len=' + $k.Length + ')' | Out-File cryptorank-result.txt -Encoding utf8 }"
