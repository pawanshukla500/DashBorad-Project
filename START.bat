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
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }" >nul 2>&1
echo     Done.
echo.

:: ── Check Hostinger VPS PostgreSQL direct connection or tunnel ─────────────
echo  [2.5/4] Checking PostgreSQL database connection...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'SilentlyContinue'; try { $c = New-Object System.Net.Sockets.TcpClient('200.141.1.119', 5433); if ($c.Connected) { $c.Close(); exit 0 } } catch {}; try { $c2 = New-Object System.Net.Sockets.TcpClient('127.0.0.1', 5432); if ($c2.Connected) { $c2.Close(); exit 0 } } catch {}; exit 1" >nul 2>&1
if errorlevel 1 (
    echo     Attempting SSH database tunnel fallback to VPS...
    start "ReconCentral DB Tunnel" /MIN "%~dp0scripts\start-tunnel.bat"
    timeout /t 3 /nobreak >nul
) else (
    echo     Database connection verified (Hostinger VPS 24/7).
)
echo.

:: ── Start Backend ──────────────────────────────────────────────────────────
echo  [3/4] Starting Backend (Express — port 3001, all interfaces)...
  pushd "%~dp0backend"
  start "ReconCentral Backend" /B npm.cmd run dev
  popd
  echo     Backend started in background.
  echo.

echo  Waiting for backend health...
call :WaitForUrl "http://127.0.0.1:3001/health" 90
if errorlevel 1 (
    echo.
    echo  Backend did not become healthy within 90 seconds.
    echo  Check the database and startup details with:
    echo    cd /d "%~dp0backend" ^&^& npm.cmd run db:verify
    echo.
    goto :END
)
echo     Backend health check passed.
echo.

  :: =======================================================================================
  :: 🚀 Start Frontend =====================================================================
  :: =======================================================================================
  echo  [4/4] Starting Frontend (Vite — port 5173, LAN enabled)...
  pushd "%~dp0frontend"
  start "" /B npm.cmd run dev -- --host
  popd
echo     Frontend started in background.
echo.

:: ── Wait for Vite to be ready then open browser ────────────────────────────
echo  Waiting for frontend...
call :WaitForUrl "http://127.0.0.1:5173/" 45
if errorlevel 1 (
    echo.
    echo  Frontend did not become ready within 45 seconds.
    echo  Check the Vite output above, then restart START.bat.
    echo.
    goto :END
)

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
:END
pause >nul
exit /b 0

:WaitForUrl
set "_URL=%~1"
set "_TRIES=%~2"
for /l %%i in (1,1,%_TRIES%) do (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%_URL%' -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { exit 0 } } catch { }; exit 1" >nul 2>&1
    if not errorlevel 1 exit /b 0
    timeout /t 1 /nobreak >nul
)
exit /b 1
