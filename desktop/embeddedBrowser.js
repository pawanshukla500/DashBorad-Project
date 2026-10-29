/**
 * Embedded browser engine for the ReconCentral desktop app.
 *
 * Electron already ships a complete Chromium — the same engine family as
 * Microsoft's WebView2 — so the app embeds its scraping browser natively via a
 * WebContentsView instead of launching an external Chrome or hosting a second
 * foreign WebView2 runtime. One browser engine inside the app window means:
 *   - workers watch the scraper live (the view IS the monitoring surface),
 *   - background mode is just hiding the view (no second browser process),
 *   - Windows and Linux behave identically (no platform lock-in),
 *   - sessions live in per-marketplace OS-encrypted Chromium partitions.
 *
 * The exported page surface deliberately mirrors the puppeteer-core calls
 * desktop/portalScraper.js already makes (goto / evaluate / waitForSelector /
 * type / cookies / setCookie / waitForNavigation), so the production scraper
 * logic runs against it unchanged. The engine wraps every evaluation in a
 * retry loop because Electron's executeJavaScript rejects while a navigation
 * destroys the renderer context — the equivalent of puppeteer's waitFor*
 * resilience — and types with real keyboard events after clearing React-
 * controlled inputs through the native value setter (a direct `.value = ''`
 * desyncs React's tracker and silently drops later keystrokes).
 *
 * This module is shipped dark: nothing imports it until the embedded-runtime
 * wiring lands, and the scrape path keeps using the external-Chrome runtime
 * unless the operator enables it. It is fully offline-testable through the
 * injected `deps` parameter.
 */

import { createRequire } from 'node:module';

const DEFAULT_EVAL_RETRIES = 3;
const DEFAULT_EVAL_GAP_MS = 300;
const POLL_RETRIES = 40;
const POLL_GAP_MS = 700;
const GOTO_SETTLE_MS = 2000;
const NAV_POLL_SETTLE_MS = 4000;
const DEFAULT_VIEW_BOUNDS = { x: 0, y: 0, width: 1280, height: 720 };

const require = createRequire(import.meta.url);

function loadElectronDeps() {
  const electron = require('electron');
  return {
    WebContentsView: electron.WebContentsView,
    session: electron.session
  };
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(message) {
  const err = new Error(message);
  err.name = 'TimeoutError';
  return err;
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Real-browser UA (the default Electron UA advertises "Electron", which no
 * human traffic ever sends). Marketplaces override per portal config.
 */
export const DEFAULT_EDGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

function toCookieUrl(cookie) {
  const domain = String(cookie?.domain || '').replace(/^\./, '');
  const path = cookie?.path || '/';
  return `https://${domain}${path.startsWith('/') ? path : `/${path}`}`;
}

function sameSiteToElectron(sameSite) {
  switch (String(sameSite || '').toLowerCase()) {
    case 'no_restriction':
    case 'none':
      return 'no_restriction';
    case 'lax':
      return 'lax';
    case 'strict':
      return 'strict';
    default:
      return 'unspecified';
  }
}

/**
 * Creates the embedded page. Options:
 *   window     BrowserWindow whose contentView hosts the embedded view.
 *   partition  Chromium session partition ('persist:<marketplace-id>') holding
 *              that marketplace's OS-encrypted cookie jar across restarts.
 *   userAgent  Real-browser UA applied before any load (DEFAULT_EDGE_USER_AGENT).
 *   visible    Start visible (background mode hides the view but keeps it running).
 *   bounds     {x,y,width,height} or () => bounds, recomputed via layout().
 *   deps       Test injection: { WebContentsView, session, delay }.
 */
export function createEmbeddedPage({
  window,
  partition,
  userAgent = DEFAULT_EDGE_USER_AGENT,
  visible = true,
  bounds = null,
  deps = {}
} = {}) {
  const electronDeps = deps.WebContentsView && deps.session ? deps : loadElectronDeps();
  const { WebContentsView, session: sessionApi } = electronDeps;
  const delay = deps.delay || defaultDelay;

  if (!partition || typeof partition !== 'string' || !partition.startsWith('persist:')) {
    throw new Error('Embedded browser requires a persistent session partition (persist:<marketplace-id>).');
  }
  if (!userAgent || /electron/i.test(userAgent)) {
    throw new Error('Embedded browser requires a real-browser user agent — the default Electron UA is never sent by human traffic.');
  }

  // Portal pages are untrusted: the view gets no Node, full isolation, sandbox.
  const embedSession = sessionApi.fromPartition(partition);
  embedSession.setUserAgent(userAgent);

  const view = new WebContentsView({
    webPreferences: {
      session: embedSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });

  const attach = () => {
    if (window?.contentView?.addChildView) window.contentView.addChildView(view);
  };
  // A WebContentsView starts at 0×0: without bounds it renders as a blank
  // surface even while marked visible. When no explicit bounds are given,
  // cover the host window's content area (or a sane default).
  const defaultBounds = () => {
    const size = window?.getContentSize?.();
    if (size && size.width > 0 && size.height > 0) {
      return { x: 0, y: 0, width: size.width, height: size.height };
    }
    return DEFAULT_VIEW_BOUNDS;
  };
  const layout = () => {
    const next = typeof bounds === 'function' ? bounds() : (bounds || defaultBounds());
    if (next && view.setBounds) view.setBounds(next);
  };
  attach();
  view.setVisible?.(Boolean(visible));
  layout();

  const contents = view.webContents;

  // Navigation tracking: the scraper clicks a submit button and only then
  // calls waitForNavigation, so a fast navigation can complete before the
  // wait's own listener registers. A persistent listener records every
  // MAIN-FRAME navigation's timestamp (did-navigate-in-page also fires for
  // subframes; an iframe's hash change is not the submit's navigation), and
  // waitForNavigation accepts a navigation that happened within a small grace
  // window before the call — but only one that fired AFTER the action armed
  // the watch (see armedAt below), so an unrelated earlier navigation can
  // never satisfy the wait.
  let lastNavAt = 0;
  const onAnyNav = () => { lastNavAt = Date.now(); };
  const onAnyInPage = (_event, _url, isMainFrame) => {
    if (isMainFrame !== false) lastNavAt = Date.now();
  };
  if (contents.on) {
    contents.on('did-navigate', onAnyNav);
    contents.on('did-navigate-in-page', onAnyInPage);
  }
  // Actions that can trigger a navigation (evaluate / click / type) arm the
  // navigation watch BEFORE their script runs, so the grace window can only
  // ever accept a navigation caused by that action — never one that preceded
  // it. waitForSelector polls deliberately do NOT re-arm: a poll landing
  // after a fast navigation must not erase it.
  let armedAt = 0;

  // networkidle2 needs a real network-quiet signal, not a fixed delay: a
  // fixed settle can resolve while slow rate-card XHRs are still in flight.
  // The view's own CDP debugger provides one (Network domain pending-request
  // count). Merely attaching does not set navigator.webdriver or any
  // automation flag — that only happens for pages launched with
  // --enable-automation. When the debugger is unavailable the adapter falls
  // back to the fixed settle instead of failing the load.
  const netMonitor = (() => {
    if (!contents.debugger?.attach || !contents.debugger?.on) return null;
    try {
      contents.debugger.attach('1.3');
    } catch {
      return null;
    }
    const state = { pending: 0 };
    contents.debugger.on('message', (_event, method) => {
      if (method === 'Network.requestWillBeSent') state.pending += 1;
      else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        state.pending = Math.max(0, state.pending - 1);
      }
    });
    try {
      contents.debugger.send('Network.enable');
    } catch {
      return null;
    }
    return state;
  })();

  const waitForNetworkQuiet = async (timeoutMs) => {
    if (!netMonitor) {
      await delay(GOTO_SETTLE_MS);
      return 'settle-fallback';
    }
    const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 10000);
    let stableSince = null;
    for (;;) {
      if (netMonitor.pending <= 2) {
        if (stableSince === null) stableSince = Date.now();
        if (Date.now() - stableSince >= 500) return 'network-quiet';
      } else {
        stableSince = null;
      }
      if (Date.now() >= deadline) return 'quiet-timeout';
      await delay(150);
    }
  };

  /**
   * executeJavaScript rejects when a navigation destroys the renderer context
   * mid-evaluation. Retrying absorbs that, exactly like puppeteer's waits do.
   * A script's own thrown errors also reject, so callers that expect page-level
   * failures pass a small retry budget; polls pass a large one. deadlineMs is
   * an absolute timestamp: when set, the retry loop never sleeps past it, so
   * a poll's caller-defined budget is honored even while every attempt fails
   * (40 retries x 700ms gaps would otherwise run a "15 second" wait minutes
   * late).
   */
  const evaluateRaw = async (script, { retries = DEFAULT_EVAL_RETRIES, gapMs = DEFAULT_EVAL_GAP_MS, deadlineMs = null } = {}) => {
    let attempt = 0;
    for (;;) {
      try {
        return await contents.executeJavaScript(script, true);
      } catch (err) {
        attempt += 1;
        const remaining = deadlineMs ? deadlineMs - Date.now() : Infinity;
        if (attempt >= retries || remaining <= 0) throw err;
        await delay(Math.min(gapMs, remaining));
      }
    }
  };

  const page = {
    _view: view,
    _contents: contents,

    url() {
      return contents.getURL ? contents.getURL() : '';
    },

    title() {
      return contents.getTitle ? contents.getTitle() : '';
    },

    /**
     * puppeteer's page.evaluate(fn) / evaluate(string). Functions serialize
     * to an immediately-invoked form so the scraper's arrow functions work
     * as-is. The scraper submits login forms through evaluate(() => el.click()),
     * so every evaluation arms the navigation watch.
     */
    async evaluate(fnOrScript, options = {}) {
      const script = typeof fnOrScript === 'function'
        ? `(${fnOrScript.toString()})()`
        : String(fnOrScript);
      armedAt = Date.now();
      return evaluateRaw(script, options);
    },

    /**
     * Navigation. Electron has no networkidle2 signal on its own, so the
     * adapter's CDP Network monitor supplies the real quiet condition
     * (≤2 pending requests held for 500ms); without the debugger it falls
     * back to a fixed settle, which the scraper's own post-goto delay
     * already tolerates. A quiet timeout FAILS the navigation: returning
     * ok while rate-card XHRs are still pending is exactly the incomplete
     * read this monitor exists to prevent. `timeout` is the budget for the
     * WHOLE navigation — load, readiness, and network quiet share one
     * deadline instead of each getting a fresh copy of the limit.
     */
    async goto(targetUrl, { waitUntil = 'load', timeout = 45000 } = {}) {
      const budget = Number.isFinite(timeout) && timeout > 0 ? timeout : 45000;
      const deadline = Date.now() + budget;
      const remaining = () => deadline - Date.now();
      const slice = () => Math.max(remaining(), 1);
      const load = contents.loadURL(targetUrl);
      await withTimeout(load, slice(), `Navigation timed out after ${timeout}ms: ${targetUrl}`);
      if (waitUntil === 'networkidle2' || waitUntil === 'load') {
        const ready = evaluateRaw(`document.readyState === 'complete' || document.readyState === 'interactive'`, { retries: 20, gapMs: 500, deadlineMs: deadline });
        await withTimeout(ready, slice(), 'Page never reached an interactive state.');
      }
      if (waitUntil === 'networkidle2') {
        const networkWait = await waitForNetworkQuiet(slice());
        if (networkWait === 'quiet-timeout') {
          throw timeoutError(`Navigation to ${targetUrl} never reached a quiet network state within ${timeout}ms`);
        }
        return { ok: true, url: page.url(), networkWait };
      }
      return { ok: true, url: page.url(), networkWait: null };
    },

    /**
     * Polls for a selector; rejects with TimeoutError when it never appears.
     * visible waits check real computed visibility (display, client rects,
     * visibility, opacity) — offsetParent alone misses visibility:hidden and
     * opacity:0 controls. The evaluation retries share the poll's own
     * deadline, so a flaky renderer can never make the wait return seconds
     * past its timeout.
     */
    async waitForSelector(selector, { visible = false, timeout = 15000 } = {}) {
      const script = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'absent';
        ${visible ? `
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || el.getClientRects().length === 0) return 'hidden';
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'hidden';
        if (Number(style.opacity) === 0) return 'hidden';` : ''}
        return 'present';
      })()`;
      const deadline = Date.now() + (Number.isFinite(timeout) && timeout > 0 ? timeout : 15000);
      for (;;) {
        let state;
        try {
          state = await evaluateRaw(script, { retries: POLL_RETRIES, gapMs: POLL_GAP_MS, deadlineMs: deadline });
        } catch (err) {
          if (Date.now() >= deadline) {
            throw timeoutError(`Waiting for selector ${selector} failed: timeout ${timeout}ms exceeded (${err.message})`);
          }
          throw err;
        }
        if (state === 'present') return { ok: true };
        if (Date.now() >= deadline) {
          throw timeoutError(`Waiting for selector ${selector} failed: timeout ${timeout}ms exceeded`);
        }
        await delay(Math.min(400, Math.max(deadline - Date.now(), 1)));
      }
    },

    /**
     * Resolves on the next top-frame navigation, honoring waitUntil the way
     * puppeteer does: 'networkidle2' additionally waits for the CDP network
     * monitor to go quiet after the navigation, so a slow login XHR is never
     * mistaken for a complete session. `timeout` bounds the WHOLE wait — the
     * navigation event, the settle pause, and the network-quiet phase share
     * one deadline. The scraper clicks a submit button
     * (through evaluate) and only then calls this, so a navigation that fired
     * after the action armed the watch, within a small grace window before
     * this call, counts too — a navigation that PRECEDED the action is
     * ignored, because it cannot be the submit's navigation.
     */
    async waitForNavigation({ timeout = 45000, graceMs = 800, waitUntil = 'load' } = {}) {
      const budget = Number.isFinite(timeout) && timeout > 0 ? timeout : 45000;
      const deadline = Date.now() + budget;
      const remaining = () => deadline - Date.now();
      const slice = () => Math.max(remaining(), 1);
      let via = 'navigation-event';
      if (lastNavAt >= armedAt && Date.now() - lastNavAt <= graceMs) {
        via = 'recent-navigation';
      } else {
        const navigated = new Promise((resolve) => {
          const onNav = () => { cleanup(); resolve(page.url()); };
          const onInPage = (_event, _url, isMainFrame) => {
            // did-navigate-in-page also fires for subframes; an iframe's
            // hash change must not satisfy a top-level login wait.
            if (isMainFrame === false) return;
            cleanup();
            resolve(page.url());
          };
          const cleanup = () => {
            contents.removeListener?.('did-navigate', onNav);
            contents.removeListener?.('did-navigate-in-page', onInPage);
          };
          if (contents.once) {
            contents.once('did-navigate', onNav);
            contents.once('did-navigate-in-page', onInPage);
          }
        });
        await withTimeout(navigated, slice(), `Navigation timed out after ${timeout}ms`);
      }
      const settleMs = Math.min(NAV_POLL_SETTLE_MS / 2, Math.max(remaining(), 0));
      if (settleMs > 0) await delay(settleMs);
      if (waitUntil === 'networkidle2') {
        const networkWait = await waitForNetworkQuiet(slice());
        if (networkWait === 'quiet-timeout') {
          throw timeoutError(`Network never reached a quiet state after navigation within ${timeout}ms`);
        }
        return { ok: true, url: page.url(), via, networkWait };
      }
      return { ok: true, url: page.url(), via };
    },

    /** Clicks via the page's own event loop (portalScraper's pattern). */
    async click(selectorOrHandler) {
      armedAt = Date.now();
      if (typeof selectorOrHandler === 'function') {
        return evaluateRaw(`(${selectorOrHandler.toString()})()`);
      }
      return evaluateRaw(`(() => {
        const el = document.querySelector(${JSON.stringify(String(selectorOrHandler))});
        if (!el) return false;
        el.click();
        return true;
      })()`);
    },

    /**
     * Real keyboard typing. Focuses and clicks the field first (focus alone
     * does not activate some React fields), clears through the native value
     * setter + input event so React's controlled-input tracker stays in sync,
     * focuses the WebContents itself — sendInputEvent only delivers input to
     * a focused WebContents, which a hidden background view never is by
     * itself — then sends one char event per keystroke, exactly as a human
     * types. If the input does not land (e.g. focus is unavailable), the
     * readback verification below fails loudly instead of silently mistyping.
     */
    async type(selector, text, { delay: perKeyMs = 45, verify = true } = {}) {
      const sel = JSON.stringify(String(selector));
      armedAt = Date.now();
      const focusState = await evaluateRaw(`(() => {
        const el = document.querySelector(${sel});
        if (!el) return 'missing';
        el.scrollIntoView({ block: 'center' });
        el.click();
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return document.activeElement === el ? 'ok' : 'not-active';
      })()`, { retries: POLL_RETRIES, gapMs: POLL_GAP_MS });
      if (focusState !== 'ok') {
        throw new Error(`Cannot type into ${selector}: the field is ${focusState}.`);
      }
      contents.focus?.();
      await delay(200);
      for (const ch of String(text)) {
        contents.sendInputEvent({ type: 'char', keyCode: ch });
        await delay(perKeyMs);
      }
      if (!verify) return true;
      const readBack = await evaluateRaw(`(() => {
        const el = document.querySelector(${sel});
        return el ? el.value : null;
      })()`);
      if (readBack !== String(text)) {
        throw new Error(`Typing verification failed for ${selector}: the field did not accept the value (got length ${(readBack || '').length}).`);
      }
      return true;
    },

    /** Puppeteer-shaped cookie list from the persistent session partition. */
    async cookies() {
      const list = await embedSession.cookies.get({});
      return list.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        sameSite: c.sameSite,
        expires: c.expirationDate || undefined,
        session: !c.expirationDate
      }));
    },

    /**
     * Puppeteer's page.setCookie(...cookies). Chromium requires a URL per
     * cookie write, so the domain+path are combined into one.
     */
    async setCookie(...cookieList) {
      const flat = cookieList.flat();
      if (!flat.length) return;
      for (const cookie of flat) {
        await embedSession.cookies.set({
          url: toCookieUrl(cookie),
          name: String(cookie.name || ''),
          value: String(cookie.value ?? ''),
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: cookie.secure !== false,
          httpOnly: Boolean(cookie.httpOnly),
          expirationDate: (Number.isFinite(cookie.expires) && cookie.expires > 0) ? cookie.expires : undefined,
          sameSite: sameSiteToElectron(cookie.sameSite)
        });
      }
    },

    /** Screenshot of the live page (monitoring + debugging aid). */
    async screenshot() {
      const image = await contents.capturePage();
      return image.toPNG();
    },

    setVisible(next) {
      view.setVisible?.(Boolean(next));
    },
    getVisible() {
      return Boolean(view.getVisible?.());
    },
    layout,

    async close() {
      if (contents.removeListener && onAnyNav) {
        contents.removeListener('did-navigate', onAnyNav);
        contents.removeListener('did-navigate-in-page', onAnyInPage);
      }
      try {
        contents.debugger?.detach?.();
      } catch {
        /* not attached */
      }
      if (window?.contentView?.removeChildView) window.contentView.removeChildView(view);
      try {
        view.webContents?.close?.();
      } catch {
        /* already destroyed */
      }
      return { ok: true };
    }
  };

  return page;
}

/**
 * Puppeteer-compatible runtime wrapper for desktop/portalScraper.js. The
 * scraper calls runtime.launch({ headless, executablePath, defaultViewport,
 * args }) — a puppeteer-shaped call that cannot carry the marketplace context —
 * so the context (persistent per-marketplace session partition, the host
 * window the visible view renders into, UA policy, bounds) is bound when the
 * runtime is CREATED, and launch() only flips visibility with headless.
 */
export function createEmbeddedRuntime({ partition, window, userAgent, bounds, deps = {} } = {}) {
  if (!partition || typeof partition !== 'string' || !partition.startsWith('persist:')) {
    throw new Error('createEmbeddedRuntime requires a persistent per-marketplace session partition (persist:<marketplace-id>).');
  }
  if (!window) {
    throw new Error('createEmbeddedRuntime requires the host BrowserWindow: the visible monitoring view must be attachable, and a detached view cannot render.');
  }
  return {
    partition,
    window,
    /**
     * launch({ headless }) — headless:false renders the visible monitoring
     * view; headless:'new'/true runs it hidden in the background. The other
     * puppeteer-shaped options (executablePath, defaultViewport, args) are
     * accepted and ignored — the embedded engine needs no external browser.
     */
    async launch(options = {}) {
      const {
        headless = false,
        userAgent: userAgentOverride,
        WebContentsView,
        session,
        delay,
        ...ignored
      } = options;
      const injectable = (WebContentsView && session) ? { WebContentsView, session, delay } : deps;
      const page = createEmbeddedPage({
        window,
        partition,
        userAgent: userAgentOverride || userAgent,
        visible: !headless,
        bounds,
        deps: injectable
      });
      let open = true;
      return {
        page,
        async pages() {
          return open ? [page] : [];
        },
        async newPage() {
          // One embedded marketplace view per partition: a second page in the
          // same session would share the cookie jar and fight over it.
          if (!open) throw new Error('Embedded browser is closed.');
          return page;
        },
        async close() {
          open = false;
          await page.close();
        },
        // Surface the ignored puppeteer-shaped options for test assertions.
        launchOptions: { ignoredKeys: Object.keys(ignored) }
      };
    }
  };
}
