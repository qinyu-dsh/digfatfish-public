@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0doctor-purge.ps1"
exit /b %ERRORLEVEL%
