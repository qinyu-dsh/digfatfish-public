@echo off
rem Delayed purge launcher (2026-09-16).
rem Why the delay: doctor-purge.ps1 kills the dsh web service, and the agent turn
rem that arranged this run lives inside that service. 120s lets the turn finish and
rem the reply reach the user before the service blinks.
rem Target list lives in doctor-purge-sessions.cjs (currently the two Ungrouped ghosts).
powershell.exe -NoProfile -Command "Start-Sleep -Seconds 120"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0doctor-purge.ps1"
exit /b %ERRORLEVEL%
