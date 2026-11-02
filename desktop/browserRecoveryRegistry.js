import { registerBrowserProfileProcess } from './browserProfileOwnership.js';
import { closeOwnedBrowserProcess, isBrowserProcessExited, watchBrowserProcessExit } from './browserProcessLifecycle.js';

/**
 * Retains Chromium handles when a close fails so a profile is never removed or
 * reopened while the old process may still own its lock.
 */
export function createBrowserRecoveryRegistry() {
  const entries = new Set();

  const isConnected = browser => {
    try { return typeof browser?.isConnected !== 'function' || browser.isConnected(); }
    catch { return false; }
  };

  const discard = entry => entries.delete(entry);

  function releaseProfileOwnership(entry) {
    if (!entry?.releaseProfileOwnership) return Promise.resolve(false);
    if (entry.ownershipReleasePromise) return entry.ownershipReleasePromise;
    entry.ownershipReleasePromise = Promise.resolve()
      .then(() => entry.releaseProfileOwnership())
      .then(() => {
        entry.releaseProfileOwnership = null;
        return true;
      })
      .finally(() => { entry.ownershipReleasePromise = null; });
    return entry.ownershipReleasePromise;
  }

  async function closeEntry(entry) {
    if (!entry) return false;
    if (!isConnected(entry.browser) && isBrowserProcessExited(entry.browser)) {
      if (entry) {
        await releaseProfileOwnership(entry);
        discard(entry);
      }
      return false;
    }

    try {
      await closeOwnedBrowserProcess(entry.browser);
    } catch (error) {
      if (isBrowserProcessExited(entry.browser)) {
        await releaseProfileOwnership(entry);
        discard(entry);
      }
      throw error;
    }

    await releaseProfileOwnership(entry);
    discard(entry);
    return true;
  }

  function track(browser, profileKey, { releaseProfileOwnership: releaseOwnership = null } = {}) {
    if (!browser || typeof browser.close !== 'function') {
      throw new Error('A Chromium browser handle is required for recovery tracking.');
    }
    const entry = {
      browser,
      profileKey: String(profileKey || ''),
      releaseProfileOwnership: typeof releaseOwnership === 'function' ? releaseOwnership : null,
      ownershipReleasePromise: null
    };
    entries.add(entry);
    browser.on?.('disconnected', () => {
      if (isBrowserProcessExited(browser)) {
        void releaseProfileOwnership(entry).then(
          () => discard(entry),
          () => {} // Keep the handle so reset can retry a failed ownership release.
        );
      } else {
        entry.removeProcessExitWatch ||= watchBrowserProcessExit(browser, () => {
          void releaseProfileOwnership(entry).then(
            () => discard(entry),
            () => {} // Keep the handle so reset can retry a failed ownership release.
          );
        });
      }
    });
    registerBrowserProfileProcess(entry.releaseProfileOwnership, browser);
    return { close: () => closeEntry(entry) };
  }

  async function closeProfile(profileKey) {
    const matching = [...entries].filter(entry => entry.profileKey === String(profileKey || ''));
    const errors = [];
    let closed = false;
    for (const entry of matching) {
      try { closed = (await closeEntry(entry)) || closed; }
      catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Could not close ${errors.length} Chromium processes for profile ${profileKey}.`);
    }
    return closed;
  }

  return {
    track,
    closeProfile,
    hasProfile: profileKey => [...entries].some(entry => entry.profileKey === String(profileKey || '') && isConnected(entry.browser)),
    size: () => entries.size
  };
}
