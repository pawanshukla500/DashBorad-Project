import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import properLockfile from 'proper-lockfile';

const PROFILE_LOCK_OPTIONS = {
  realpath: false,
  stale: 120000,
  update: 30000,
  retries: 0
};

function createProfileInUseError() {
  const error = new Error('Seller Hub browser profile is already open in another ReconCentral process. Close that browser before continuing.');
  error.code = 'BROWSER_PROFILE_IN_USE';
  return error;
}

function ownerProcessIsAlive(target) {
  try {
    if (!fs.existsSync(`${target}.lock`)) return false;
    const metadata = JSON.parse(fs.readFileSync(`${target}.owner.json`, 'utf8'));
    const processIds = [...new Set([
      metadata?.pid,
      ...(Array.isArray(metadata?.browserPids) ? metadata.browserPids : [])
    ].filter(pid => Number.isSafeInteger(pid) && pid > 0))];
    return processIds.some(processIdIsAlive);
  } catch {
    return false;
  }
}

function processIdIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled by this user.
    // Unknown OS errors fail closed; only ESRCH proves the process is gone.
    return error?.code !== 'ESRCH';
  }
}

function writeOwnerMetadata(ownerPath, metadata) {
  const tempPath = `${ownerPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, ownerPath);
    try { fs.chmodSync(ownerPath, 0o600); } catch {}
  } finally {
    try { fs.unlinkSync(tempPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

export function getBrowserProfileLockTarget(profileDir) {
  if (typeof profileDir !== 'string' || !profileDir.trim() || !path.isAbsolute(profileDir)) {
    throw new TypeError('An absolute marketplace browser profile path is required.');
  }
  const resolved = path.resolve(profileDir);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  return path.join(path.dirname(resolved), `.reconcentral-profile-owner-${digest}`);
}

/**
 * Acquires cross-process ownership before Chromium opens a persistent profile.
 * The lease must be held until Chromium's child process has exited, including
 * recovery paths where the DevTools connection closes before the process.
 */
export async function acquireBrowserProfileOwnership(profileDir) {
  const target = getBrowserProfileLockTarget(profileDir);
  const profileParent = path.dirname(target);
  fs.mkdirSync(profileParent, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(profileParent, 0o700); } catch {}

  // proper-lockfile uses heartbeat age to recover locks after a crash. A live
  // app can have a stale heartbeat while the machine sleeps, so consult the
  // recorded PID first and never steal ownership from a process that exists.
  if (ownerProcessIsAlive(target)) throw createProfileInUseError();

  let unlock;
  try {
    unlock = await properLockfile.lock(target, PROFILE_LOCK_OPTIONS);
  } catch (error) {
    if (error?.code === 'ELOCKED') {
      throw createProfileInUseError();
    }
    throw error;
  }

  const ownerPath = `${target}.owner.json`;
  const ownerMetadata = { pid: process.pid, browserPids: [], started_at: Date.now() };
  try {
    try { fs.unlinkSync(ownerPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    writeOwnerMetadata(ownerPath, ownerMetadata);
  } catch (error) {
    await unlock();
    throw error;
  }

  const registerBrowserProcess = browser => {
    let browserProcess;
    try { browserProcess = browser?.process?.(); } catch {}
    const pid = browserProcess?.pid;
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    if (!ownerMetadata.browserPids.includes(pid)) ownerMetadata.browserPids.push(pid);
    writeOwnerMetadata(ownerPath, ownerMetadata);
    return true;
  };

  let released = false;
  let releasing = null;
  const release = async () => {
    if (released) return false;
    if (releasing) return releasing;
    releasing = Promise.resolve().then(() => {
      try { fs.unlinkSync(ownerPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      return unlock();
    }).then(() => {
      released = true;
      return true;
    }).finally(() => {
      releasing = null;
    });
    return releasing;
  };
  release.registerBrowserProcess = registerBrowserProcess;
  return release;
}

export function registerBrowserProfileProcess(releaseOwnership, browser) {
  if (typeof releaseOwnership?.registerBrowserProcess !== 'function') return false;
  return releaseOwnership.registerBrowserProcess(browser);
}

export async function withBrowserProfileOwnership(profileDir, action) {
  if (typeof action !== 'function') throw new TypeError('A browser profile ownership action is required.');
  const release = await acquireBrowserProfileOwnership(profileDir);
  try {
    return await action();
  } finally {
    await release();
  }
}
