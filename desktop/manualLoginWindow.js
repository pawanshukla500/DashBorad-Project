import { FLIPKART_MANUAL_LOGIN_URL } from './portalSession.js';

const isAlive = window => Boolean(window && !window.isDestroyed());

function safeNotify(onState, state) {
  try { onState(state); } catch {}
}

function safeLog(log, level, event, details = {}) {
  try { log(level, event, details); } catch {}
}

export function normalizeElectronSessionCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies.filter(cookie => cookie && cookie.name && cookie.domain && cookie.value !== undefined)
    .map(cookie => {
      const result = {
        name: String(cookie.name),
        value: String(cookie.value),
        domain: String(cookie.domain),
        path: cookie.path || '/',
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        session: cookie.session === true || !Number.isFinite(cookie.expirationDate)
      };
      if (!result.session) result.expires = cookie.expirationDate;
      const sameSite = String(cookie.sameSite || '').toLowerCase();
      if (sameSite === 'strict') result.sameSite = 'Strict';
      else if (sameSite === 'lax') result.sameSite = 'Lax';
      else if (sameSite === 'no_restriction' || sameSite === 'none') result.sameSite = 'None';
      if (cookie.partitionKey) result.partitionKey = cookie.partitionKey;
      return result;
    });
}

function isFlipkartHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'flipkart.com' || url.hostname.endsWith('.flipkart.com'));
  } catch {
    return false;
  }
}

/**
 * Opens a separate, visible Electron Chromium window on the same persistent
 * session partition used by the embedded scraper. Login is always manual; the
 * manager never clicks a login/signup control or navigates to a deep link.
 */
export function createManualLoginWindowManager({
  BrowserWindow,
  portalSession,
  isAuthenticated,
  readCookies,
  saveCookies,
  onState = () => {},
  log = () => {},
  timeoutMs = 10 * 60 * 1000,
  pollMs = 1000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (typeof BrowserWindow !== 'function' || !portalSession || typeof isAuthenticated !== 'function' ||
      typeof readCookies !== 'function' || typeof saveCookies !== 'function') {
    throw new Error('Manual Seller Hub login requires a BrowserWindow, persistent session, authentication check and cookie storage.');
  }

  let loginWindow = null;
  let watcher = null;

  const currentState = (window, patch = {}) => ({
    active: true,
    status: 'login_prompt',
    engine: 'manual-login-window',
    marketplace: 'flipkart_shopsy',
    url: isAlive(window) ? (window.webContents.getURL?.() || FLIPKART_MANUAL_LOGIN_URL) : FLIPKART_MANUAL_LOGIN_URL,
    title: isAlive(window) ? (window.webContents.getTitle?.() || 'Flipkart Seller Hub — Manual Sign-in') : 'Flipkart Seller Hub — Manual Sign-in',
    ...patch
  });

  const createWindow = () => {
    if (isAlive(loginWindow)) {
      loginWindow.show?.();
      loginWindow.focus?.();
      return loginWindow;
    }

    const window = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 960,
      minHeight: 640,
      show: true,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      title: 'Flipkart Seller Hub — Manual Sign-in',
      webPreferences: {
        session: portalSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    loginWindow = window;

    window.webContents.setWindowOpenHandler?.(({ url }) => {
      if (!isFlipkartHttpsUrl(url)) {
        let hostname = 'unknown';
        try { hostname = new URL(url).hostname; } catch {}
        safeLog(log, 'warn', 'portal.login_popup_blocked', { hostname });
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: true,
          webPreferences: {
            session: portalSession,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      };
    });

    window.webContents.on?.('did-navigate', (_event, url) => {
      safeNotify(onState, currentState(window, { url }));
    });
    window.webContents.on?.('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame === false || code === -3) return;
      safeLog(log, 'error', 'portal.login_window.navigation_failed', {
        errorCode: code,
        message: description,
        hostname: (() => { try { return new URL(url).hostname; } catch { return 'unknown'; } })()
      });
      safeNotify(onState, currentState(window, { status: 'error', errorCode: code, error: description }));
    });
    window.webContents.on?.('render-process-gone', (_event, details) => {
      safeLog(log, 'error', 'portal.login_window.renderer_gone', { reason: details?.reason || 'unknown' });
      safeNotify(onState, currentState(window, { status: 'error', error: 'Seller Hub sign-in window renderer stopped.' }));
    });
    window.on('closed', () => {
      if (loginWindow === window) loginWindow = null;
      safeNotify(onState, {
        active: false,
        status: 'login_required',
        engine: 'manual-login-window',
        marketplace: 'flipkart_shopsy',
        url: FLIPKART_MANUAL_LOGIN_URL,
        title: 'Seller Hub sign-in window closed'
      });
      if (watcher?.window === window) watcher.finish({
        success: false,
        error: 'Seller Hub sign-in window was closed before authentication completed.'
      });
    });

    safeLog(log, 'info', 'portal.login_window.opened', { url: FLIPKART_MANUAL_LOGIN_URL });
    safeNotify(onState, currentState(window));
    Promise.resolve(window.loadURL(FLIPKART_MANUAL_LOGIN_URL)).catch(error => {
      safeLog(log, 'error', 'portal.login_window.navigation_failed', { message: error?.message || String(error) });
      safeNotify(onState, currentState(window, { status: 'error', error: error?.message || String(error) }));
    });
    return window;
  };

  const startWatcher = window => {
    if (watcher?.window === window) return watcher.promise;

    let resolvePromise;
    let interval = null;
    let checking = false;
    let settled = false;
    const promise = new Promise(resolve => { resolvePromise = resolve; });
    const currentWatcher = {
      window,
      promise,
      finish(result) {
        if (settled) return;
        settled = true;
        if (interval !== null) clearIntervalFn(interval);
        if (watcher === currentWatcher) watcher = null;
        resolvePromise(result);
      }
    };
    watcher = currentWatcher;

    const check = async () => {
      if (checking || settled) return;
      checking = true;
      try {
        if (!isAlive(window)) {
          currentWatcher.finish({ success: false, error: 'Seller Hub sign-in window is no longer available.' });
          return;
        }
        if (await isAuthenticated(window.webContents)) {
          const cookies = await readCookies(portalSession);
          await saveCookies(Array.isArray(cookies) ? cookies : []);
          const result = { success: true, cookiesCount: Array.isArray(cookies) ? cookies.length : 0, persistentSession: true };
          safeLog(log, 'info', 'portal.login_window.authenticated', { cookieCount: result.cookiesCount });
          safeNotify(onState, currentState(window, {
            active: false,
            status: 'completed',
            sessionSaved: true,
            cookiesCount: result.cookiesCount,
            progressMessage: 'Seller Hub session saved. You can close this window; the worker will reuse the persistent session.'
          }));
          currentWatcher.finish(result);
          return;
        }
      } catch (error) {
        safeLog(log, 'warn', 'portal.login_window.auth_check_retry', { message: error?.message || String(error) });
      } finally {
        checking = false;
      }
    };

    interval = setIntervalFn(check, pollMs);
    check();
    return promise;
  };

  const open = async ({ waitMs = timeoutMs } = {}) => {
    const window = createWindow();
    safeNotify(onState, currentState(window, {
      active: true,
      status: 'login_prompt',
      progressMessage: 'Sign in manually in the separate Seller Hub window. The app saves this persistent session for the worker.'
    }));
    const authentication = startWatcher(window);
    let timeoutHandle;
    const timeout = new Promise(resolve => {
      timeoutHandle = setTimeoutFn(() => resolve({
        success: false,
        waitingForManualLogin: true,
        error: 'Manual Seller Hub sign-in is still waiting. Leave the window open and finish login; its session will still be saved.'
      }), waitMs);
    });
    const result = await Promise.race([authentication, timeout]);
    clearTimeoutFn(timeoutHandle);
    return result;
  };

  return {
    open,
    getWindow: () => isAlive(loginWindow) ? loginWindow : null,
    close: () => { if (isAlive(loginWindow)) loginWindow.close(); }
  };
}
