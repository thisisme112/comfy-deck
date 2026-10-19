@echo off
setlocal
chcp 65001 >nul
title ComfyDeck - ComfyUI Manager
cd /d "%~dp0"

set "PY=..\python_embeded\python.exe"
if not exist "%PY%" set "PY=python"

echo.
echo   ComfyDeck - ComfyUI Manager
echo   http://127.0.0.1:8288
echo.
echo   Press Ctrl+C to stop.
echo.

"%PY%" server.py %*
if errorlevel 1 (
  echo.
  echo ComfyDeck stopped with an error.
  pause
)
endlocal
