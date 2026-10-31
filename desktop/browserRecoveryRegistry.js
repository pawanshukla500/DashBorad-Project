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

  async function closeEntry(entry) {
    if (!entry || !isConnected(entry.browser)) {
      if (entry) discard(entry);
      return false;
    }

    try {
      await entry.browser.close();
    } catch (error) {
      if (!isConnected(entry.browser)) discard(entry);
      throw error;
    }

    if (isConnected(entry.browser)) {
      throw new Error(`Chromium remained connected after close for profile ${entry.profileKey || '(unknown)'}.`);
    }
    discard(entry);
    return true;
  }

  function track(browser, profileKey) {
    if (!browser || typeof browser.close !== 'function') {
      throw new Error('A Chromium browser handle is required for recovery tracking.');
    }
    const entry = { browser, profileKey: String(profileKey || '') };
    entries.add(entry);
    browser.on?.('disconnected', () => discard(entry));
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
