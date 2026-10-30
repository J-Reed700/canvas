@echo off
title Downbeat Studio
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" --yes --app %*
if errorlevel 1 (
    echo.
    echo Downbeat encountered an error during startup.
    pause
)
