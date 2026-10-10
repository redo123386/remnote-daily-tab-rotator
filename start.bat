@echo off
title Daily Tab Rotator (RemNote plugin)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

netstat -ano | findstr /r /c:":8080 .*LISTENING" >nul
if not errorlevel 1 (
  echo Something is already running on port 8080 - the plugin server is probably already open.
  echo Close the other window first if you want to restart it.
  pause
  exit /b 0
)

if not exist node_modules (
  echo First run: installing dependencies, this takes a minute...
  call npm install
  if errorlevel 1 (
    echo npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

echo.
echo Starting Daily Tab Rotator at http://localhost:8080
echo Keep this window open while you use RemNote. Close it to stop the plugin.
echo.
call npm run dev

echo.
echo The plugin server stopped.
pause
