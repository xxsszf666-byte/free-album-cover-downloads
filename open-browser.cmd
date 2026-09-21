@echo off
setlocal
set "URL=http://127.0.0.1:38471"
set "PROFILE=%TEMP%\netease-cover-downloader-browser"

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --no-first-run --no-default-browser-check --no-proxy-server --proxy-bypass-list=127.0.0.1;localhost --user-data-dir="%PROFILE%" "%URL%"
  exit /b 0
)

if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --no-first-run --no-default-browser-check --no-proxy-server --proxy-bypass-list=127.0.0.1;localhost --user-data-dir="%PROFILE%" "%URL%"
  exit /b 0
)

start "" "%URL%"
