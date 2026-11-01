/**
 * Keeps the authenticated Seller Hub Chrome process alive for the lifetime of
 * the desktop app. Session cookies can otherwise be discarded when login and
 * scraping each launch and close a separate Chromium process.
 */
export function createExternalBrowserSession({ onPage = () => {}, onLifecycle = () => {} } = {}) {
  let retained = null;
  const recoveryEntries = new Set();

  const notify = (callback, ...args) => {
    try { callback(...args); } catch {}
  };

  const isConnected = browser => {
    try { return typeof browser?.isConnected !== 'function' || browser.isConnected(); }
    catch { return false; }
  };

  const pageIsOpen = page => {
    try { return Boolean(page && (typeof page.isClosed !== 'function' || !page.isClosed())); }
    catch { return false; }
  };

  const getPage = async (browser, preferredPage = null) => {
    const pages = await browser.pages();
    if (pageIsOpen(preferredPage) && pages.includes(preferredPage)) return preferredPage;
    const openPage = pages.find(pageIsOpen);
    return openPage || await browser.newPage();
  };

  const lease = (entry, keepOpen) => new Proxy(entry.browser, {
    get(target, property) {
      if (property === 'close') {
        return async (...args) => {
          if (keepOpen && retained === entry) return;
          return closeEntry(entry, 'released', args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  async function closeEntry(entry, reason = 'released', closeArgs = []) {
    if (!entry) return false;
    entry.closing = true;
    try {
      if (isConnected(entry.browser)) await entry.browser.close(...closeArgs);
    } catch (error) {
      entry.closing = false;
      // Keep the process handle so a failed close cannot strand Chromium with
      // the profile lock and cause the next acquire to launch a duplicate.
      if (isConnected(entry.browser)) {
        recoveryEntries.add(entry);
        notify(onLifecycle, 'close-failed', { profileKey: entry.profileKey, reason });
        throw error;
      }
    }
    entry.closing = false;
    recoveryEntries.delete(entry);
    if (retained === entry) retained = null;
    notify(onPage, null);
    notify(onLifecycle, 'closed', { profileKey: entry.profileKey, reason });
    return true;
  }

  async function acquire(runtime, options = {}, { profileKey = options.userDataDir || '', keepOpen = options.headless === false } = {}) {
    if (!runtime || typeof runtime.launch !== 'function') {
      throw new Error('A Chromium runtime is required to open the Seller Hub browser.');
    }

    if (retained && !isConnected(retained.browser)) {
      const disconnected = retained;
      retained = null;
      recoveryEntries.delete(disconnected);
      notify(onPage, null);
      notify(onLifecycle, 'disconnected', { profileKey: disconnected.profileKey });
    }

    if (retained && retained.profileKey === profileKey) {
      const entry = retained;
      try {
        entry.page = await getPage(entry.browser, entry.page);
      } catch (error) {
        try { await closeEntry(entry, 'page-acquisition-failed'); } catch {}
        throw error;
      }
      notify(onPage, entry.page);
      notify(onLifecycle, 'reused', { profileKey, url: entry.page.url?.() || '' });
      return {
        browser: lease(entry, true),
        page: entry.page,
        retained: true,
        reused: true
      };
    }

    if (retained) await closeEntry(retained, 'profile-changed');

    for (const entry of [...recoveryEntries]) {
      if (entry.profileKey === profileKey) await closeEntry(entry, 'retry-cleanup');
    }

    const browser = await runtime.launch(options);
    const entry = { browser, page: null, profileKey, closing: false };
    browser.on?.('disconnected', () => {
      recoveryEntries.delete(entry);
      if (entry.closing) return;
      if (retained !== entry) return;
      retained = null;
      notify(onPage, null);
      notify(onLifecycle, 'disconnected', { profileKey });
    });
    try {
      entry.page = await getPage(browser);
    } catch (error) {
      try { await closeEntry(entry, 'page-acquisition-failed'); } catch {}
      throw error;
    }
    const page = entry.page;
    if (keepOpen) {
      retained = entry;
    }
    notify(onPage, page);
    notify(onLifecycle, keepOpen ? 'retained' : 'launched', { profileKey, url: page.url?.() || '' });
    return {
      browser: lease(entry, keepOpen),
      page,
      retained: keepOpen,
      reused: false
    };
  }

  async function close({ profileKey, reason = 'requested' } = {}) {
    const candidates = [...new Set([...(retained ? [retained] : []), ...recoveryEntries])]
      .filter(entry => profileKey === undefined || entry.profileKey === profileKey);
    if (!candidates.length) return false;
    let closed = false;
    for (const entry of candidates) {
      closed = (await closeEntry(entry, reason)) || closed;
    }
    return closed;
  }

  function selectPage(profileKey, page) {
    if (!retained || retained.profileKey !== profileKey || !isConnected(retained.browser) || !pageIsOpen(page)) return false;
    try {
      const pageBrowser = page.browser?.();
      if (pageBrowser && pageBrowser !== retained.browser) return false;
    } catch { return false; }
    retained.page = page;
    notify(onPage, page);
    let url = '';
    try { url = page.url?.() || ''; } catch {}
    notify(onLifecycle, 'page-selected', { profileKey, url });
    return true;
  }

  function getRetainedPage(profileKey) {
    if (!retained || (profileKey && retained.profileKey !== profileKey) || !isConnected(retained.browser)) return null;
    return pageIsOpen(retained.page) ? retained.page : null;
  }

  return {
    acquire,
    close,
    getPage: getRetainedPage,
    selectPage,
    getProfileKey: () => retained?.profileKey || null,
    hasBrowser: () => Boolean(
      (retained && isConnected(retained.browser)) ||
      [...recoveryEntries].some(entry => isConnected(entry.browser))
    )
  };
}
