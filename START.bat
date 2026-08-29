@echo off
title ReconCentral — Starting...
color 0A
setlocal EnableDelayedExpansion

echo.
echo  =============================================
echo   ReconCentral — Starting Up
echo  =============================================
echo.

:: ── Detect LAN IP for teammate sharing ─────────────────────────────────────
set "LAN_IP="
set "TEAM_URL="
for /f "usebackq tokens=1,* delims==" %%a in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lan-ip.ps1"`) do (
  if /I "%%a"=="LAN_IP" set "LAN_IP=%%b"
  if /I "%%a"=="TEAM_URL" set "TEAM_URL=%%b"
)

:: ── Optional: open Windows Firewall for LAN (Private profile) ──────────────
echo  [1/4] LAN firewall rules (ports 5173 + 3001)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\lan-ip.ps1" -OpenFirewall >nul 2>&1
if errorlevel 1 (
    echo     Tip: run START.bat as Administrator once if teammates cannot connect.
) else (
    echo     Firewall rules checked.
)
echo.

:: ── Kill anything already running on ports 3001 and 5173 ──────────────────
echo  [2/4] Freeing ports 3001 and 5173...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001 " 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5173 " 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)
echo     Done.
echo.

:: ── Start Backend ──────────────────────────────────────────────────────────
echo  [3/4] Starting Backend (Express — port 3001, all interfaces)...
pushd "%~dp0backend"
start "" /B "C:\Program Files\nodejs\npm.cmd" run dev
popd
echo     Backend started in background.
echo.

:: ── Wait a moment for backend to initialize before starting frontend ───────
timeout /t 3 /nobreak >nul

:: ── Start Frontend ─────────────────────────────────────────────────────────
echo  [4/4] Starting Frontend (Vite — port 5173, LAN enabled)...
pushd "%~dp0frontend"
start "" /B "C:\Program Files\nodejs\npm.cmd" run dev -- --host
popd
echo     Frontend started in background.
echo.

:: ── Wait for Vite to be ready then open browser ────────────────────────────
echo  Waiting for servers to be ready...
timeout /t 5 /nobreak >nul

echo  Opening browser at http://localhost:5173
start "" "http://localhost:5173"

echo.
echo  =============================================
echo   ReconCentral is running
echo  =============================================
echo   You (this PC):
echo     Frontend : http://localhost:5173
echo     Backend  : http://localhost:3001
echo.
if defined LAN_IP (
  echo   Share with teammates SAME Wi-Fi / LAN:
  echo     App URL  : http://!LAN_IP!:5173
  echo.
  echo   Copy that link into chat / WhatsApp.
  echo   They do NOT need to run START.bat — only you do.
  echo.
  echo   Requirements:
  echo     - Same network as this PC
  echo     - Windows Firewall allowed ports 5173 + 3001
  echo       (run START.bat as Admin once if blocked)
  echo     - If Firebase login fails for them, add this PC's
  echo       IP to Firebase Auth ^> Authorized domains
) else (
  echo   Could not detect LAN IP automatically.
  echo   Run: ipconfig   and share your IPv4 + :5173
)
echo  =============================================
echo.
echo  Both servers are now running in this terminal.
echo  Press Ctrl+C to stop the servers, or close this window to exit completely.
pause >nul
