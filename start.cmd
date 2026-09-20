@echo off
setlocal
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required.
  echo Download it from https://nodejs.org/
  pause
  exit /b 1
)

node "%~dp0server.js" --open
if errorlevel 1 pause
