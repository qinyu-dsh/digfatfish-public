@echo off
rem Delayed launcher for restore-sessions.ps1 (2026-09-21).
rem Why the delay: the ps1 kills the dsh web service and the agent turn that
rem arranged this run lives inside that service. 120s lets the turn finish and
rem the reply reach the user before the service blinks.
powershell.exe -NoProfile -Command "Start-Sleep -Seconds 120"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-sessions.ps1"
exit /b %ERRORLEVEL%
