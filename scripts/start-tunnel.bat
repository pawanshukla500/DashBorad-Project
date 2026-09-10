@echo off
title ReconCentral Database Tunnel (Auto-reconnecting)
color 0B

echo.
echo ========================================================
echo  ReconCentral 24/7 SSH Database Tunnel to Hostinger VPS
echo  Local: localhost:5432 -^> Hostinger VPS: 200.141.1.119:5433
echo ========================================================
echo.

:TUNNEL_LOOP
echo [%DATE% %TIME%] Connecting to Hostinger VPS database tunnel...
ssh -N -L 5432:127.0.0.1:5433 -o ExitOnForwardFailure=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=6 -o TCPKeepAlive=yes -o StrictHostKeyChecking=accept-new root@200.141.1.119

echo.
echo [%DATE% %TIME%] SSH tunnel disconnected or network changed.
echo [%DATE% %TIME%] Auto-reconnecting in 3 seconds...
timeout /t 3 /nobreak >nul
goto :TUNNEL_LOOP
