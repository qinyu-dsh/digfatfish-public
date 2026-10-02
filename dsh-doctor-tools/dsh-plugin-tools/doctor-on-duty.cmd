@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0doctor-on-duty.ps1"
exit /b %ERRORLEVEL%
