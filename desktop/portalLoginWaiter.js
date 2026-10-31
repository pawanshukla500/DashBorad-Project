import { isFlipkartAuthenticated } from './portalSession.js';

const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    const error = new Error('Seller Hub sign-in monitoring was cancelled.');
    error.name = 'AbortError';
    reject(error);
    return;
  }

  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, ms);
  const abort = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    const error = new Error('Seller Hub sign-in monitoring was cancelled.');
    error.name = 'AbortError';
    reject(error);
  };
  signal?.addEventListener('abort', abort, { once: true });
});

/**
 * A Seller Hub sign-in may leave the public landing page open while the
 * account flow runs in another tab. Watch every page in the same persistent
 * Chromium profile so login verification follows the actual authenticated
 * Seller Hub page instead of being pinned to the original tab.
 */
export async function waitForFlipkartAuthenticatedPage(browser, {
  initialPage,
  timeoutMs = 30 * 60 * 1000,
  pollMs = 1000,
  isAuthenticated = isFlipkartAuthenticated,
  wait = delay,
  now = Date.now,
  onPage = () => {},
  signal
} = {}) {
  if (!browser || typeof browser.pages !== 'function' || !initialPage || typeof initialPage.evaluate !== 'function') {
    throw new Error('Seller Hub sign-in monitoring requires the active browser and its initial page.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs < 1000) {
    throw new Error('Seller Hub readiness checks must be at least one second apart.');
  }

  const pages = new Set();
  const addPage = page => {
    if (!page || page.isClosed?.() || pages.has(page)) return;
    pages.add(page);
    if (page !== initialPage) {
      try { onPage(page); } catch {}
    }
  };
  addPage(initialPage);

  const deadline = now() + timeoutMs;
  do {
    if (signal?.aborted) {
      const error = new Error('Seller Hub sign-in monitoring was cancelled.');
      error.name = 'AbortError';
      throw error;
    }
    try {
      for (const page of await browser.pages()) addPage(page);
    } catch {
      // Chrome may be replacing targets during the Seller Hub login redirect.
    }

    let checkedPage = false;
    for (const page of pages) {
      if (page.isClosed?.()) continue;
      if (checkedPage) await wait(pollMs, signal);
      if (now() >= deadline) break;
      checkedPage = true;
      try {
        if (await page.evaluate(isAuthenticated)) return page;
      } catch {
        // A renderer can navigate between discovery and evaluation; retry next tick.
      }
    }

    if (now() >= deadline) break;
    await wait(pollMs, signal);
  } while (now() <= deadline);

  throw new Error('Manual Seller Hub sign-in timed out. No authenticated dashboard was detected in any open Chrome tab. Complete sign-in in the worker Chrome window and try again.');
}
