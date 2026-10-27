@echo off
title ReconCentral RateCard Desktop Control Center
cls
echo ======================================================================
echo   ReconCentral - Flipkart and Shopsy RateCard Desktop Control Center
echo ======================================================================
echo.
cd /d "%~dp0"

echo [1/2] Checking Node.js runtime...
node -v >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Error: Node.js is not found in PATH. Please install Node.js.
    pause
    exit /b 1
)

echo [2/2] Launching Desktop Control Center Server and Chrome App Window...
echo.
node desktop/desktopServer.mjs

pause
