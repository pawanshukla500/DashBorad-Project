import fs from 'node:fs';
import path from 'node:path';

const STATE_FILE = '.reconcentral-sellerhub-session.json';
const VALID_STATES = new Set(['authenticated', 'signed_out', 'snapshot_available']);

/**
 * Read the last Seller Hub state confirmed by this app for a Chromium profile.
 * `unknown` is the migration state for profiles created by older app versions.
 */
export function readSellerHubProfileState(profileDir, { fsModule = fs } = {}) {
  if (!profileDir) return 'unknown';
  try {
    const state = JSON.parse(fsModule.readFileSync(path.join(profileDir, STATE_FILE), 'utf8'));
    return state?.version === 1 && VALID_STATES.has(state.status) ? state.status : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Persist only non-secret session metadata; cookie values stay in Chromium/cookieVault. */
export function writeSellerHubProfileState(profileDir, status, { fsModule = fs, now = () => new Date() } = {}) {
  if (!profileDir || !VALID_STATES.has(status)) {
    throw new TypeError('A browser profile and valid Seller Hub session state are required.');
  }
  fsModule.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(profileDir, STATE_FILE);
  fsModule.writeFileSync(statePath, `${JSON.stringify({ version: 1, status, updatedAt: now().toISOString() })}\n`, { mode: 0o600 });
  try { fsModule.chmodSync(statePath, 0o600); } catch {}
  return statePath;
}
