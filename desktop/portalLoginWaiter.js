import { inspectFlipkartLoginState, isFlipkartAuthenticated } from './portalSession.js';

const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason instanceof Error ? signal.reason : abortError('Seller Hub sign-in monitoring was cancelled.'));
    return;
  }

  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, ms);
  const abort = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    reject(signal.reason instanceof Error ? signal.reason : abortError('Seller Hub sign-in monitoring was cancelled.'));
  };
  signal?.addEventListener('abort', abort, { once: true });
});

function abortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

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
  inspectState = inspectFlipkartLoginState,
  publicReturnGraceMs = 5000,
  wait = delay,
  now = Date.now,
  onPage = () => {},
  onState = () => {},
  signal
} = {}) {
  if (!browser || typeof browser.pages !== 'function' || !initialPage || typeof initialPage.evaluate !== 'function') {
    throw new Error('Seller Hub sign-in monitoring requires the active browser and its initial page.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs < 1000 ||
      !Number.isFinite(publicReturnGraceMs) || publicReturnGraceMs < pollMs) {
    throw new Error('Seller Hub readiness checks must be at least one second apart.');
  }

  const monitorController = new AbortController();
  const monitorSignal = monitorController.signal;
  const stopOnBrowserDisconnect = () => monitorController.abort(abortError('Chrome was closed while waiting for Seller Hub sign-in.'));
  const stopOnCallerAbort = () => monitorController.abort(
    signal?.reason instanceof Error ? signal.reason : abortError('Seller Hub sign-in monitoring was cancelled.')
  );
  browser.once?.('disconnected', stopOnBrowserDisconnect);
  signal?.addEventListener('abort', stopOnCallerAbort, { once: true });
  if (signal?.aborted) stopOnCallerAbort();

  const pages = new Set();
  const reportedStates = new Map();
  let loginFormObserved = false;
  let publicReturnSince = null;
  const addPage = page => {
    if (!page || page.isClosed?.() || pages.has(page)) return;
    pages.add(page);
    if (page !== initialPage) {
      try { onPage(page); } catch {}
    }
  };
  addPage(initialPage);

  const throwIfAborted = () => {
    if (monitorSignal.aborted) {
      throw monitorSignal.reason instanceof Error
        ? monitorSignal.reason
        : abortError('Seller Hub sign-in monitoring was cancelled.');
    }
  };

  try {
    const deadline = now() + timeoutMs;
    do {
      throwIfAborted();
      try {
        for (const page of await browser.pages()) addPage(page);
      } catch {
        // Chrome may be replacing targets during the Seller Hub login redirect.
        throwIfAborted();
      }

      let checkedPage = false;
      const pageStates = [];
      for (const page of pages) {
        throwIfAborted();
        if (page.isClosed?.()) continue;
        if (checkedPage) await wait(pollMs, monitorSignal);
        throwIfAborted();
        if (now() >= deadline) break;
        checkedPage = true;
        try {
          const inspection = await page.evaluate(inspectState);
          // The browser-facing inspector includes auth proof and the visible
          // login stage. Boolean results keep custom test/integration probes
          // compatible with the original `isAuthenticated` contract.
          const authenticated = typeof inspection === 'boolean'
            ? inspection
            : Boolean(inspection?.authenticated);
          if (authenticated) return page;
          if (inspection && typeof inspection === 'object') pageStates.push({ page, state: inspection });
          if (!authenticated && (isAuthenticated !== isFlipkartAuthenticated || inspectState !== inspectFlipkartLoginState)) {
            const fallback = await page.evaluate(isAuthenticated);
            if (fallback) return page;
          }
        } catch {
          // A renderer can navigate between discovery and evaluation; retry next tick.
          throwIfAborted();
        }
      }

      const relevantStates = pageStates.filter(item => item.state.surface === 'flipkart');
      const activeLoginFlow = relevantStates.some(({ state }) => state.loginFormVisible || state.challengeVisible);
      if (activeLoginFlow) loginFormObserved = true;
      const returnedToPublicLanding = loginFormObserved && relevantStates.length > 0 &&
        relevantStates.every(({ state }) => state.publicLanding) && !activeLoginFlow;
      if (returnedToPublicLanding) {
        if (publicReturnSince === null) publicReturnSince = now();
      } else {
        publicReturnSince = null;
      }

      for (const { page, state } of pageStates) {
        const stage = state.publicLanding && returnedToPublicLanding ? 'public_return' : state.stage;
        const stateForUi = { ...state, stage };
        const signature = JSON.stringify(stateForUi);
        if (reportedStates.get(page) === signature) continue;
        reportedStates.set(page, signature);
        try { onState(page, stateForUi); } catch {}
      }

      if (publicReturnSince !== null && now() - publicReturnSince >= publicReturnGraceMs) {
        throw new Error('Seller Hub returned to its public landing page after the sign-in form closed. No authenticated dashboard was detected; review the login result in Chrome. Nothing was staged.');
      }

      throwIfAborted();
      if (now() >= deadline) break;
      await wait(pollMs, monitorSignal);
    } while (now() <= deadline);

    throw new Error('Manual Seller Hub sign-in timed out. No authenticated dashboard was detected in any open Chrome tab. Complete sign-in in the worker Chrome window and try again.');
  } finally {
    if (typeof browser.off === 'function') browser.off('disconnected', stopOnBrowserDisconnect);
    else browser.removeListener?.('disconnected', stopOnBrowserDisconnect);
    signal?.removeEventListener('abort', stopOnCallerAbort);
  }
}
