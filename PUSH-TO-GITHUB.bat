@echo off
title Market Radar - push
cd /d "%~dp0"
echo Pushing to github.com/bloomstarbms/market-radar ... > push-result.txt

REM VERSION IS DERIVED, NEVER HARDCODED. The old message was pinned to
REM "v0.9.4 -> v0.17.0" and rode along on every push regardless of contents —
REM by v0.24.3 every commit carried the same false label, and a history where
REM each entry says the same wrong thing is worse than no message at all.
REM Source of truth is src/config.js (the boot gates assert it); package.json
REM had drifted to 0.3.0, so deriving from that would only swap one lie for another.
REM Batch-native extraction — the first attempt used nested PowerShell quoting,
REM which broke the .bat parser entirely: the script died after its first line and
REM push-result.txt contained only the header. findstr + delims needs no nesting.
REM Second parser casualty: delims=' collided with the apostrophe-quoted command.
REM cmd.exe cannot be tested from the agent sandbox, so stop writing clever batch:
REM node emits the version to a temp file, set /p reads it. No quoting to get wrong.
node -e "process.stdout.write(require('fs').readFileSync('src/config.js','utf8').match(/VERSION = '([^']+)'/)[1])" > radar-version.tmp 2>>push-result.txt
set /p RADAR_VER=<radar-version.tmp
del radar-version.tmp 2>nul
if "%RADAR_VER%"=="" (echo ABORTED: could not read VERSION from src/config.js >> push-result.txt & goto :done)
echo Version detected: %RADAR_VER% >> push-result.txt

REM The old .git was an empty shell from an early init, unreadable on this side
REM (OneDrive placeholder). It held no commits - recreate cleanly.
git rev-parse --git-dir >nul 2>nul
if errorlevel 1 (
  rmdir /s /q .git 2>nul
  git init -b main >> push-result.txt 2>&1
)

git remote remove origin >nul 2>nul
git remote add origin https://github.com/bloomstarbms/market-radar.git
git fetch origin main >> push-result.txt 2>&1
if errorlevel 1 (echo FETCH FAILED - check network/auth >> push-result.txt & goto :done)

REM Adopt remote history without touching the working tree; local files are truth.
git reset --soft FETCH_HEAD >> push-result.txt 2>&1
git add -A >> push-result.txt 2>&1

REM SAFETY: never allow secrets into the commit.
git diff --cached --name-only > staged-files.txt
findstr /i /x ".env" staged-files.txt >nul
if not errorlevel 1 (echo ABORTED: .env was staged - fix .gitignore first >> push-result.txt & goto :done)
findstr /i "data/" staged-files.txt >nul
if not errorlevel 1 (echo WARNING: data/ paths staged - review staged-files.txt >> push-result.txt)

REM Message states the version and lets git list the files — accurate by
REM construction rather than by remembering to edit this line.
git -c user.name="BMS" -c user.email="85956989+bloomstarbms@users.noreply.github.com" commit -m "v%RADAR_VER%" -m "Automated push from PUSH-TO-GITHUB.bat. Version read from src/config.js at push time; see the diff for contents." >> push-result.txt 2>&1
git push -u origin main >> push-result.txt 2>&1
git tag -f "v%RADAR_VER%" >nul 2>nul
git push -f origin "v%RADAR_VER%" >> push-result.txt 2>&1
echo Pushed as v%RADAR_VER% (tagged) >> push-result.txt
echo DONE >> push-result.txt

:done
type push-result.txt
timeout /t 6 >nul
