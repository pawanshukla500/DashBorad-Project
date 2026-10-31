/**
 * Keeps the authenticated Seller Hub Chrome process alive for the lifetime of
 * the desktop app. Session cookies can otherwise be discarded when login and
 * scraping each launch and close a separate Chromium process.
 */
export function createExternalBrowserSession({ onPage = () => {}, onLifecycle = () => {} } = {}) {
  let retained = null;

  const notify = (callback, ...args) => {
    try { callback(...args); } catch {}
  };

  const isConnected = browser => {
    try { return typeof browser?.isConnected !== 'function' || browser.isConnected(); }
    catch { return false; }
  };

  const getPage = async browser => {
    const pages = await browser.pages();
    const openPage = pages.find(candidate => {
      try { return typeof candidate.isClosed !== 'function' || !candidate.isClosed(); }
      catch { return false; }
    });
    return openPage || await browser.newPage();
  };

  const lease = (entry, keepOpen) => new Proxy(entry.browser, {
    get(target, property) {
      if (property === 'close') {
        return async (...args) => {
          if (keepOpen && retained === entry) return;
          if (retained === entry) retained = null;
          try {
            return await target.close(...args);
          } finally {
            notify(onPage, null);
            notify(onLifecycle, 'closed', { profileKey: entry.profileKey });
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  async function closeEntry(entry, reason = 'released') {
    if (!entry) return false;
    if (retained === entry) retained = null;
    try {
      if (isConnected(entry.browser)) await entry.browser.close();
    } finally {
      notify(onPage, null);
      notify(onLifecycle, 'closed', { profileKey: entry.profileKey, reason });
    }
    return true;
  }

  async function acquire(runtime, options = {}, { profileKey = options.userDataDir || '', keepOpen = options.headless === false } = {}) {
    if (!runtime || typeof runtime.launch !== 'function') {
      throw new Error('A Chromium runtime is required to open the Seller Hub browser.');
    }

    if (retained && !isConnected(retained.browser)) {
      const disconnected = retained;
      retained = null;
      notify(onPage, null);
      notify(onLifecycle, 'disconnected', { profileKey: disconnected.profileKey });
    }

    if (retained && retained.profileKey === profileKey) {
      retained.page = await getPage(retained.browser);
      notify(onPage, retained.page);
      notify(onLifecycle, 'reused', { profileKey, url: retained.page.url?.() || '' });
      return {
        browser: lease(retained, true),
        page: retained.page,
        retained: true,
        reused: true
      };
    }

    if (retained) await closeEntry(retained, 'profile-changed');

    const browser = await runtime.launch(options);
    const page = await getPage(browser);
    const entry = { browser, page, profileKey };
    if (keepOpen) {
      retained = entry;
      browser.on?.('disconnected', () => {
        if (retained !== entry) return;
        retained = null;
        notify(onPage, null);
        notify(onLifecycle, 'disconnected', { profileKey });
      });
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
    if (!retained || (profileKey !== undefined && retained.profileKey !== profileKey)) return false;
    return closeEntry(retained, reason);
  }

  return {
    acquire,
    close,
    getPage: () => retained?.page || null,
    getProfileKey: () => retained?.profileKey || null,
    hasBrowser: () => Boolean(retained && isConnected(retained.browser))
  };
}
