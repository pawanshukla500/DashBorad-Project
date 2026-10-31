import test from 'node:test';
import assert from 'node:assert/strict';
import { createExternalBrowserSession } from '../externalBrowserSession.js';

class FakeBrowser {
  constructor(id) {
    this.id = id;
    this.closed = false;
    this.listeners = new Map();
    this.page = {
      isClosed: () => this.closed,
      url: () => `https://seller.flipkart.com/${this.id}`
    };
  }

  isConnected() { return !this.closed; }
  on(event, callback) { this.listeners.set(event, callback); }
  async pages() { return this.closed ? [] : [this.page]; }
  async newPage() { this.page = { isClosed: () => false, url: () => 'about:blank' }; return this.page; }
  async close() {
    this.closed = true;
    this.listeners.get('disconnected')?.();
  }
}

function fakeRuntime() {
  const browsers = [];
  return {
    browsers,
    async launch(options) {
      const browser = new FakeBrowser(String(browsers.length + 1));
      browser.options = options;
      browsers.push(browser);
      return browser;
    }
  };
}

test('manual login browser is reused by extraction and closes only on explicit teardown', async () => {
  const runtime = fakeRuntime();
  const pages = [];
  const session = createExternalBrowserSession({ onPage: page => pages.push(page) });

  const login = await session.acquire(runtime, {
    headless: false,
    userDataDir: 'profile-flipkart'
  }, { profileKey: 'profile-flipkart', keepOpen: true });

  assert.equal(login.retained, true);
  assert.equal(session.hasBrowser(), true);
  assert.equal(session.getPage(), login.page);
  await login.browser.close();
  assert.equal(runtime.browsers[0].closed, false, 'the login helper must not close the authenticated browser');

  const scrape = await session.acquire(runtime, {
    headless: 'new',
    userDataDir: 'profile-flipkart'
  }, { profileKey: 'profile-flipkart', keepOpen: false });

  assert.equal(scrape.reused, true);
  assert.equal(scrape.browser.id, login.browser.id);
  assert.equal(scrape.page, login.page);
  assert.equal(runtime.browsers.length, 1, 'extraction must not launch a second Chromium process for the same profile');
  await scrape.browser.close();
  assert.equal(runtime.browsers[0].closed, false, 'scrape cleanup must preserve the signed-in browser');

  assert.equal(await session.close({ profileKey: 'profile-flipkart', reason: 'cookie-reset' }), true);
  assert.equal(runtime.browsers[0].closed, true);
  assert.equal(session.hasBrowser(), false);
  assert.equal(pages.at(-1), null, 'teardown clears the live page reference');
});

test('a headless scrape browser is released while a visible browser is retained', async () => {
  const runtime = fakeRuntime();
  const session = createExternalBrowserSession();
  const lease = await session.acquire(runtime, { headless: 'new', userDataDir: 'profile' }, {
    profileKey: 'profile', keepOpen: false
  });

  assert.equal(lease.retained, false);
  assert.equal(session.hasBrowser(), false);
  await lease.browser.close();
  assert.equal(runtime.browsers[0].closed, true);

  const visible = await session.acquire(runtime, { headless: false, userDataDir: 'profile' }, {
    profileKey: 'profile', keepOpen: true
  });
  assert.equal(visible.retained, true);
  assert.equal(session.hasBrowser(), true);
  await session.close();
});

test('a disconnected retained browser is discarded before a fresh session launches', async () => {
  const runtime = fakeRuntime();
  const lifecycle = [];
  const session = createExternalBrowserSession({ onLifecycle: event => lifecycle.push(event) });
  const first = await session.acquire(runtime, { headless: false }, { profileKey: 'profile', keepOpen: true });

  await runtime.browsers[0].close();
  assert.equal(session.hasBrowser(), false);
  const next = await session.acquire(runtime, { headless: false }, { profileKey: 'profile', keepOpen: true });

  assert.equal(next.reused, false);
  assert.equal(runtime.browsers.length, 2);
  assert(lifecycle.includes('disconnected'));
  await session.close();
  assert.equal(first.browser.id, '1');
});

test('a launched browser is closed when its first page cannot be acquired', async () => {
  const runtime = fakeRuntime();
  runtime.launch = async options => {
    const browser = new FakeBrowser('page-error');
    browser.options = options;
    browser.pages = async () => { throw new Error('Chromium page enumeration failed'); };
    runtime.browsers.push(browser);
    return browser;
  };
  const lifecycle = [];
  const session = createExternalBrowserSession({ onLifecycle: event => lifecycle.push(event) });

  await assert.rejects(
    session.acquire(runtime, { headless: false }, { profileKey: 'profile', keepOpen: true }),
    /page enumeration failed/
  );

  assert.equal(runtime.browsers[0].closed, true, 'failed page acquisition must release the launched Chrome process');
  assert.equal(session.hasBrowser(), false, 'failed acquisition must not retain a broken browser');
  assert(lifecycle.includes('closed'));
});

test('a retained browser is discarded when its page can no longer be acquired', async () => {
  const runtime = fakeRuntime();
  const session = createExternalBrowserSession();
  await session.acquire(runtime, { headless: false }, { profileKey: 'profile', keepOpen: true });
  runtime.browsers[0].pages = async () => { throw new Error('Browser page is unavailable'); };

  await assert.rejects(
    session.acquire(runtime, { headless: false }, { profileKey: 'profile', keepOpen: true }),
    /page is unavailable/
  );

  assert.equal(runtime.browsers[0].closed, true);
  assert.equal(session.hasBrowser(), false);
});

test('a retained browser handle survives a rejected close and can be closed on retry', async () => {
  const runtime = fakeRuntime();
  const session = createExternalBrowserSession();
  const lease = await session.acquire(runtime, { headless: false }, { profileKey: 'profile', keepOpen: true });
  const browser = runtime.browsers[0];
  const close = browser.close.bind(browser);
  let rejectClose = true;
  browser.close = async (...args) => {
    if (rejectClose) throw new Error('Chromium refused to close');
    return close(...args);
  };

  await assert.rejects(session.close({ profileKey: 'profile' }), /refused to close/);
  assert.equal(session.hasBrowser(), true, 'a close failure must not discard the retained browser handle');
  assert.equal(session.getProfileKey(), 'profile');

  rejectClose = false;
  assert.equal(await session.close({ profileKey: 'profile' }), true);
  assert.equal(session.hasBrowser(), false);
  assert.equal(browser.closed, true);
  assert.equal(lease.browser.id, '1');
});

test('a launch cleanup failure is retried before another process can use the same profile', async () => {
  const runtime = fakeRuntime();
  let rejectFirstClose = true;
  runtime.launch = async options => {
    const browser = new FakeBrowser(String(runtime.browsers.length + 1));
    browser.options = options;
    if (browser.id === '1') {
      browser.pages = async () => { throw new Error('Initial page is unavailable'); };
      browser.close = async () => {
        if (rejectFirstClose) throw new Error('Profile is still locked');
        browser.closed = true;
        browser.listeners.get('disconnected')?.();
      };
    }
    runtime.browsers.push(browser);
    return browser;
  };
  const session = createExternalBrowserSession();
  const options = { headless: false, userDataDir: 'profile' };
  const acquireOptions = { profileKey: 'profile', keepOpen: true };

  await assert.rejects(session.acquire(runtime, options, acquireOptions), /Initial page is unavailable/);
  assert.equal(runtime.browsers.length, 1);
  await assert.rejects(session.acquire(runtime, options, acquireOptions), /Profile is still locked/);
  assert.equal(runtime.browsers.length, 1, 'a second process must not launch while cleanup still fails');

  rejectFirstClose = false;
  assert.equal(await session.close({ profileKey: 'profile', reason: 'cookie-reset' }), true);
  assert.equal(runtime.browsers[0].closed, true, 'explicit reset must close a browser held for recovery');

  const recovered = await session.acquire(runtime, options, acquireOptions);
  assert.equal(runtime.browsers.length, 2);
  assert.equal(recovered.reused, false);
  assert.equal(session.getPage(), recovered.page);
  await session.close();
});
