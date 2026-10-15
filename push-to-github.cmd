@echo off
rem ---------------------------------------------------------------------------
rem  First upload of this project to an EMPTY GitHub repository.
rem
rem    scripts\push-to-github.cmd https://github.com/YOUR-NAME/sinsap.git
rem
rem  Needs Git for Windows (https://git-scm.com/download/win). The first push
rem  opens a browser window to sign in to GitHub (Git Credential Manager).
rem  Secrets are never uploaded: .env*, .data, .vercel and service-account
rem  key files are listed in .gitignore and are checked again below.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."

if "%~1"=="" (
  echo Usage: scripts\push-to-github.cmd https://github.com/YOUR-NAME/sinsap.git
  exit /b 2
)

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed. Install it from https://git-scm.com/download/win and run this again.
  exit /b 1
)

if not exist ".git" (
  git init -b main || exit /b 1
)

git add -A || exit /b 1

rem Refuse to continue if anything secret got staged.
git diff --cached --name-only | findstr /R /I "^\.env ^\.env\. \.data/ \.vercel/ service-account serviceaccount google-credentials" | findstr /V /I "\.env\.example" >nul
if not errorlevel 1 (
  echo STOP: a secret file is staged. Check the list below, fix .gitignore, then run again.
  git diff --cached --name-only | findstr /R /I "^\.env ^\.env\. \.data/ \.vercel/ service-account serviceaccount google-credentials" | findstr /V /I "\.env\.example"
  git reset -q
  exit /b 1
)

rem A Google key file can have any name: look inside the staged files too.
git grep --cached -l -F "private_key_id" >nul 2>nul
if not errorlevel 1 (
  echo STOP: a Google service-account key file is inside the project folder:
  git grep --cached -l -F "private_key_id"
  echo Move it out of this folder ^(keep it in Downloads^), then run again.
  git reset -q
  exit /b 1
)

for /f "delims=" %%e in ('git config user.email') do set GIT_EMAIL=%%e
if "%GIT_EMAIL%"=="" (
  echo Git does not know who you are yet. Run these two lines once, then run this script again:
  echo   git config --global user.name "Your Name"
  echo   git config --global user.email "you@example.com"
  git reset -q
  exit /b 1
)

git commit -m "Sinsap: personal finance and portfolio web app" || echo (nothing new to commit)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin "%~1" || exit /b 1
) else (
  git remote set-url origin "%~1" || exit /b 1
)

git push -u origin main || exit /b 1
echo.
echo Done. Next: connect this repository to the Vercel project (see docs\DEPLOY-GOOGLE-SHEETS.md, step 5).
endlocal
