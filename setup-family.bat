@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js 22.4 or later and run this file again.
  pause
  exit /b 1
)
node setup-family.js %*
set "FAMILY_SETUP_EXIT=%errorlevel%"
pause
exit /b %FAMILY_SETUP_EXIT%
