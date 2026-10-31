import path from 'node:path';
import os from 'node:os';

/** Resolve the same persistent Seller Hub Chrome profile used by the desktop app. */
export function getFlipkartBrowserProfileDir({ env = process.env, platform = process.platform } = {}) {
  // desktopServer.mjs supports RECONCENTRAL_USER_DATA as an operator override,
  // while Electron and its child processes use RECON_USER_DATA_DIR.
  let userDataDir = env.RECONCENTRAL_USER_DATA || env.RECON_USER_DATA_DIR;
  if (!userDataDir) {
    if (platform === 'win32' && env.APPDATA) {
      userDataDir = path.join(env.APPDATA, 'reconcentral-ratecard-worker');
    } else if (platform === 'darwin' && env.HOME) {
      userDataDir = path.join(env.HOME, 'Library', 'Application Support', 'reconcentral-ratecard-worker');
    } else if (env.XDG_CONFIG_HOME) {
      userDataDir = path.join(env.XDG_CONFIG_HOME, 'reconcentral-ratecard-worker');
    } else {
      userDataDir = path.join(env.HOME || os.homedir(), '.config', 'reconcentral-ratecard-worker');
    }
  }
  return path.join(path.resolve(userDataDir), 'browser-profiles', 'flipkart_shopsy');
}
