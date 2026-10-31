import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DESKTOP_PRODUCT_NAME = 'ReconCentral RateCard Worker';
const LEGACY_PACKAGE_NAME = 'reconcentral-ratecard-worker';

/** Resolve the single persistent application data directory used by both launchers. */
export function resolveDesktopUserDataDir({ env = process.env, platform = process.platform, homeDir = os.homedir(), scriptDir = process.cwd() } = {}) {
  const override = env.RECONCENTRAL_USER_DATA || env.RECON_USER_DATA_DIR;
  if (override) return path.resolve(override);
  const resolvedHome = env.HOME || homeDir;

  if (platform === 'win32') {
    const roaming = env.APPDATA || path.join(resolvedHome, 'AppData', 'Roaming');
    return path.join(roaming, DESKTOP_PRODUCT_NAME);
  }
  if (platform === 'darwin') {
    return path.join(resolvedHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
  }
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME || path.join(resolvedHome, '.config');
    return path.join(configHome, LEGACY_PACKAGE_NAME);
  }
  return path.join(scriptDir, '.runtime');
}

function hasChromiumProfile(profileDir, existsSync) {
  return [
    path.join(profileDir, 'Default', 'Network', 'Cookies'),
    path.join(profileDir, 'Default', 'Cookies'),
    path.join(profileDir, 'Default', 'Local Storage', 'leveldb', 'CURRENT')
  ].some(marker => existsSync(marker));
}

/**
 * Resolve the shared Flipkart profile. Existing Windows installs created by
 * the old standalone helper used the package name as their data-directory
 * name. Reuse that profile only when the canonical desktop profile has no
 * Chromium stores, so a saved manual Seller Hub session is not abandoned.
 * This checks marker-file existence only; cookie data is never read or copied.
 */
export function resolveFlipkartBrowserProfileDir(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const userDataDir = options.userDataDir || resolveDesktopUserDataDir({ env, platform });
  const allowLegacyProfile = options.allowLegacyProfile ?? (
    !options.userDataDir && !env.RECONCENTRAL_USER_DATA && !env.RECON_USER_DATA_DIR
  );
  const existsSync = options.existsSync || fs.existsSync;
  if (env.RECON_FLIPKART_PROFILE_DIR) return path.resolve(env.RECON_FLIPKART_PROFILE_DIR);

  const canonical = path.join(path.resolve(userDataDir), 'browser-profiles', 'flipkart_shopsy');
  if (platform !== 'win32' || !allowLegacyProfile) return canonical;
  if (hasChromiumProfile(canonical, existsSync)) return canonical;

  const roaming = env.APPDATA || path.dirname(userDataDir);
  const legacy = path.join(roaming, LEGACY_PACKAGE_NAME, 'browser-profiles', 'flipkart_shopsy');
  return legacy !== canonical && hasChromiumProfile(legacy, existsSync) ? legacy : canonical;
}
