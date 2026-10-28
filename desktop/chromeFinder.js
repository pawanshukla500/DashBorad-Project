/**
 * Cross-Platform Chrome & Chromium Binary Resolver
 * 
 * Accurately discovers Google Chrome, Chromium, Brave, or Edge across:
 * - Windows (Program Files, LocalAppData)
 * - Linux (/usr/bin, /snap/bin, $PATH, which)
 * - macOS (/Applications)
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export function getChromeExecutablePath() {
  // 1. Explicit override from environment
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const localAppData = process.env.LOCALAPPDATA || '';

  // 2. Windows standard paths
  const winPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(localAppData, 'Microsoft\\Edge\\Application\\msedge.exe')
  ];

  // 3. Linux standard paths
  const linuxPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/brave-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable'
  ];

  // 4. macOS standard paths
  const macPaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ];

  const possiblePaths = isWin ? winPaths : isMac ? macPaths : linuxPaths;
  const found = possiblePaths.find(p => {
    try {
      return Boolean(p && fs.existsSync(p));
    } catch {
      return false;
    }
  });

  if (found) return found;

  // 5. Dynamic fallback for Unix via `which`
  if (!isWin) {
    for (const binName of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'brave']) {
      try {
        const stdout = execSync(`which ${binName} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (stdout && fs.existsSync(stdout)) {
          return stdout;
        }
      } catch {}
    }
  }

  // Final fallback string
  if (isWin) return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (isMac) return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return '/usr/bin/google-chrome';
}
