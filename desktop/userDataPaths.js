import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DESKTOP_PRODUCT_NAME = 'ReconCentral RateCard Worker';
const LEGACY_PACKAGE_NAME = 'reconcentral-ratecard-worker';
const WINDOWS_DATA_ROOT_MARKER = '.desktop-user-data-root';
const WINDOWS_APP_STATE_FILES = ['auth-session.json', 'worker-config.json', 'staging.db'];

function getWindowsUserDataPaths({ env, homeDir }) {
  const roaming = env.APPDATA || path.join(env.HOME || homeDir, 'AppData', 'Roaming');
  return {
    canonical: path.join(roaming, DESKTOP_PRODUCT_NAME),
    legacy: path.join(roaming, LEGACY_PACKAGE_NAME)
  };
}

function countWindowsAppStateFiles(directory, existsSync) {
  return WINDOWS_APP_STATE_FILES.reduce((count, name) => count + Number(existsSync(path.join(directory, name))), 0);
}

function getWindowsAuthSessionMtime(directory, existsSync, statSync) {
  const sessionFile = path.join(directory, 'auth-session.json');
  if (!existsSync(sessionFile)) return null;
  try {
    const mtimeMs = Number(statSync(sessionFile).mtimeMs);
    return Number.isFinite(mtimeMs) ? mtimeMs : null;
  } catch {
    return null;
  }
}

function readWindowsDataRootMarker(canonical, existsSync, readFileSync) {
  const marker = path.join(canonical, WINDOWS_DATA_ROOT_MARKER);
  if (!existsSync(marker)) return null;
  try {
    const value = String(readFileSync(marker, 'utf8')).trim();
    return value === 'legacy' || value === 'canonical' ? value : null;
  } catch {
    return null;
  }
}

/** Resolve the single persistent application data directory used by both launchers. */
export function resolveDesktopUserDataDir({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  scriptDir = process.cwd(),
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  statSync = fs.statSync
} = {}) {
  const override = env.RECONCENTRAL_USER_DATA || env.RECON_USER_DATA_DIR;
  if (override) return path.resolve(override);
  const resolvedHome = env.HOME || homeDir;

  if (platform === 'win32') {
    const { canonical, legacy } = getWindowsUserDataPaths({ env, homeDir: resolvedHome });
    const markerChoice = readWindowsDataRootMarker(canonical, existsSync, readFileSync);
    if (markerChoice === 'canonical') return canonical;
    if (markerChoice === 'legacy' && existsSync(legacy)) return legacy;

    // Older Windows releases kept app state under the package-name directory.
    // Prefer the root holding the current desktop auth session, then the root
    // holding more app state. Chromium's profile stays in place and is never copied.
    const canonicalHasSession = existsSync(path.join(canonical, 'auth-session.json'));
    const legacyHasSession = existsSync(path.join(legacy, 'auth-session.json'));
    if (canonicalHasSession !== legacyHasSession) return canonicalHasSession ? canonical : legacy;
    if (canonicalHasSession && legacyHasSession) {
      const canonicalSessionMtime = getWindowsAuthSessionMtime(canonical, existsSync, statSync);
      const legacySessionMtime = getWindowsAuthSessionMtime(legacy, existsSync, statSync);
      if (canonicalSessionMtime !== null && legacySessionMtime !== null && canonicalSessionMtime !== legacySessionMtime) {
        return canonicalSessionMtime > legacySessionMtime ? canonical : legacy;
      }
      if (canonicalSessionMtime === null && legacySessionMtime !== null) return legacy;
      return canonical;
    }
    if (countWindowsAppStateFiles(legacy, existsSync) > countWindowsAppStateFiles(canonical, existsSync)) {
      return legacy;
    }
    return canonical;
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

/** Persist the first Windows data-root choice so logout cannot revive a stale legacy session. */
export function persistDesktopUserDataDirChoice(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const override = env.RECONCENTRAL_USER_DATA || env.RECON_USER_DATA_DIR;
  if (override || platform !== 'win32') return resolveDesktopUserDataDir(options);

  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const statSync = options.statSync || fs.statSync;
  const mkdirSync = options.mkdirSync || fs.mkdirSync;
  const writeFileSync = options.writeFileSync || fs.writeFileSync;
  const warn = options.warn || console.warn;
  const homeDir = options.homeDir || os.homedir();
  const { canonical, legacy } = getWindowsUserDataPaths({ env, homeDir: env.HOME || homeDir });
  const marker = path.join(canonical, WINDOWS_DATA_ROOT_MARKER);
  const markerExists = existsSync(marker);
  const markerChoice = markerExists ? readWindowsDataRootMarker(canonical, existsSync, readFileSync) : null;
  const selected = resolveDesktopUserDataDir({ ...options, env, platform, existsSync, readFileSync, statSync });
  const choice = path.resolve(selected) === path.resolve(legacy) ? 'legacy' : 'canonical';

  try {
    mkdirSync(canonical, { recursive: true });
    if (markerExists && markerChoice !== choice) {
      // Heal invalid markers and stale legacy markers whose directory has gone.
      writeFileSync(marker, `${choice}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 });
    } else if (!markerExists) {
      writeFileSync(marker, `${choice}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    // A concurrent launch may have written the same marker. Other marker I/O
    // failures should not prevent the desktop app from opening its data.
    if (error?.code === 'EEXIST') {
      return resolveDesktopUserDataDir({ ...options, env, platform, existsSync, readFileSync, statSync });
    }
    try {
      warn(JSON.stringify({
        level: 'warn',
        event: 'windows_desktop_user_data_marker_write_failed',
        code: error?.code || 'unknown'
      }));
    } catch {}
    return selected;
  }

  return resolveDesktopUserDataDir({ ...options, env, platform, existsSync, readFileSync, statSync });
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
