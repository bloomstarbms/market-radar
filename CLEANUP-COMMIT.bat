@echo off
cd /d "%~dp0"
del /f v0.17.0 2>nul
git rm --cached status.txt push-result.txt backfill-result.txt acceptance2-result.txt cryptorank-result.txt moralis-result.txt v0.17.0 > cleanup-result.tmp 2>&1
git add .gitignore >> cleanup-result.tmp 2>&1
git commit -m "Ignore runtime output files; remove stray artifacts" >> cleanup-result.tmp 2>&1
git push >> cleanup-result.tmp 2>&1
echo DONE >> cleanup-result.tmp
timeout /t 4 >nul
