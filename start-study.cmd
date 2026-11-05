@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later is required. Install from https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules (
  call npm ci
  if errorlevel 1 goto failed
)
call npm run build
if errorlevel 1 goto failed
echo.
echo Open http://127.0.0.1:4317 in your browser.
echo Keep this window open. Press Ctrl+C to stop.
call npm start
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo Could not start. Please review the message above.
pause
exit /b 1
