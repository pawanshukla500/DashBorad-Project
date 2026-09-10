import { spawn } from 'child_process';
import net from 'net';

const LOCAL_PORT = Number.parseInt(process.env.DB_TUNNEL_LOCAL_PORT || '5432', 10);
const REMOTE_PORT = Number.parseInt(process.env.DB_TUNNEL_REMOTE_PORT || '5433', 10);
const VPS_HOST = process.env.DB_TUNNEL_HOST || '200.141.1.119';
const VPS_USER = process.env.DB_TUNNEL_USER || 'root';

function checkPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(port, host);
  });
}

let activeProcess = null;

export async function ensureTunnel() {
  const isOpen = await checkPortOpen(LOCAL_PORT);
  if (isOpen) {
    return true;
  }

  console.log(`[DB-TUNNEL] Opening secure SSH tunnel: localhost:${LOCAL_PORT} -> ${VPS_HOST}:${REMOTE_PORT}...`);

  const args = [
    '-N',
    '-L', `${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}`,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=6',
    '-o', 'TCPKeepAlive=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    `${VPS_USER}@${VPS_HOST}`,
  ];

  activeProcess = spawn('ssh', args, { stdio: 'inherit' });

  activeProcess.on('error', (err) => {
    console.error(`[DB-TUNNEL] Failed to launch SSH tunnel: ${err.message}`);
  });

  activeProcess.on('exit', (code) => {
    console.log(`[DB-TUNNEL] SSH tunnel process exited with code ${code}.`);
    activeProcess = null;
  });

  // Wait for the port to become reachable
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (await checkPortOpen(LOCAL_PORT)) {
      console.log(`[DB-TUNNEL] Secure tunnel established! PostgreSQL is now reachable at localhost:${LOCAL_PORT}`);
      return true;
    }
  }

  console.warn('[DB-TUNNEL] Tunnel started but port verification timed out.');
  return false;
}

// If executed directly, run in a 24/7 self-healing watch loop
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('db-tunnel.js')) {
  console.log('[DB-TUNNEL] Starting 24/7 self-healing tunnel watchdog...');
  async function monitorLoop() {
    while (true) {
      try {
        const isOpen = await checkPortOpen(LOCAL_PORT);
        if (!isOpen) {
          console.log('[DB-TUNNEL] Port 5432 unreachable. Re-establishing SSH tunnel...');
          await ensureTunnel();
        }
      } catch (err) {
        console.error('[DB-TUNNEL] Watchdog check error:', err.message);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  monitorLoop().catch(console.error);
}
