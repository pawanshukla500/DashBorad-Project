import { isFlipkartAuthenticated } from './portalSession.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  onPage = () => {}
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
    try {
      for (const page of await browser.pages()) addPage(page);
    } catch {
      // Chrome may be replacing targets during the Seller Hub login redirect.
    }

    let checkedPage = false;
    for (const page of pages) {
      if (page.isClosed?.()) continue;
      if (checkedPage) await wait(pollMs);
      if (now() >= deadline) break;
      checkedPage = true;
      try {
        if (await page.evaluate(isAuthenticated)) return page;
      } catch {
        // A renderer can navigate between discovery and evaluation; retry next tick.
      }
    }

    if (now() >= deadline) break;
    await wait(pollMs);
  } while (now() <= deadline);

  throw new Error('Manual Seller Hub sign-in timed out. No authenticated dashboard was detected in any open Chrome tab. Complete sign-in in the worker Chrome window and try again.');
}
