@echo off
setlocal
cd /d "%~dp0"
title Agetra Terminal - LIVE
if not exist "runtime\node.exe" (
  echo The runtime is missing. Extract the complete portable ZIP before starting.
  pause
  exit /b 1
)
set "PORT=4318"
set "ENABLE_LIVE_TRADING=false"
"runtime\node.exe" --env-file-if-exists=.env "scripts\launch-windows.mjs"
if errorlevel 1 pause
