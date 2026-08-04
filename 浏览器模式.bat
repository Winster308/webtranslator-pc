@echo off
cd /d "%~dp0"
title WebTranslator Browser Mode
echo ============================================
echo   WebTranslator PC - Browser Mode
echo ============================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js 18+ from https://nodejs.org
    pause
    exit /b 1
)

echo [MODE] Browser mode ^(auto open default browser^)
echo Service URL will be printed below. If the browser page keeps loading,
echo copy the URL and paste it into the browser manually.
echo This window is the server console - keep it open while using.
echo Press Ctrl+C to exit.
echo.
node main.js
if %errorlevel% neq 0 (
    echo.
    echo Exited with error, press any key...
    pause
)
