@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto missing_node
where npm >nul 2>&1
if errorlevel 1 goto missing_npm

if not exist "node_modules\express\package.json" (
  echo The full server version needs Express, SQLite and PDF packages.
  echo Installing them will download project dependencies once.
  choice /c YN /m "Download and install these packages now?"
  if errorlevel 2 goto finished
  call npm install
  if errorlevel 1 goto install_failed
)

echo.
echo Coffee shop demo is starting.
echo Open http://localhost:3000 in your browser.
echo Keep this window open while presenting. Press Ctrl+C to stop.
echo.
call npm start
goto finished

:missing_node
echo Node.js is not installed. Install it from https://nodejs.org, then run this file again.
goto finished

:missing_npm
echo npm was not found. Reinstall Node.js from https://nodejs.org, then run this file again.
goto finished

:install_failed
echo Dependency installation failed. Check your internet connection and try again.

:finished
echo.
pause
