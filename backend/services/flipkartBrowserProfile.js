import { resolveFlipkartBrowserProfileDir } from '../../desktop/userDataPaths.js';

/** Resolve the same persistent Seller Hub Chrome profile used by the desktop app. */
export function getFlipkartBrowserProfileDir({ env = process.env, platform = process.platform, userDataDir, allowLegacyProfile, existsSync } = {}) {
  return resolveFlipkartBrowserProfileDir({ env, platform, userDataDir, allowLegacyProfile, ...(existsSync ? { existsSync } : {}) });
}
