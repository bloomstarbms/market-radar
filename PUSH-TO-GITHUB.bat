@echo off
title Market Radar - push v0.9.4 -> v0.17.0
cd /d "%~dp0"
echo Pushing to github.com/bloomstarbms/market-radar ... > push-result.txt

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

git -c user.name="BMS" -c user.email="85956989+bloomstarbms@users.noreply.github.com" commit -m "v0.9.4 -> v0.17.0: alert budget + dedup state machine, precision weighting, rug screen, taxonomy, executability gate + universe sweep, robust baselines, macro calendar, unlock three-state discipline, Upbit module, public channel, daily backups, property/replay/regression tests" >> push-result.txt 2>&1
git push -u origin main >> push-result.txt 2>&1
echo DONE >> push-result.txt

:done
type push-result.txt
timeout /t 6 >nul
