@echo off
rem Paperweight launcher (fallback). Prefer Paperweight.vbs for a silent start.
rem Do NOT run as administrator - it breaks drag-and-drop and hides network drives.
cd /d "%~dp0"
if not exist "node_modules\.bin\electron.cmd" (
  echo Electron is not installed yet. Run:  npm install
  pause
  exit /b 1
)
start "" "node_modules\.bin\electron.cmd" .
