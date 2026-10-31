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
  const loginFlowPages = new Set();
  const flowOriginTargets = new Set();
  const flowAncestorTargets = new Set();
  const flowDescendantPages = new Set();
  const flowDescendantTargets = new Set();
  const flowAncestorPages = new Set();
  const initialLineagePages = new Set([initialPage]);
  const initialLineageTargets = new Set();
  const pageByTarget = new Map();
  const publicReturnSince = new Map();
  const targetOf = page => {
    try { return page.target?.() || null; } catch { return null; }
  };
  const addPage = page => {
    if (!page || page.isClosed?.() || pages.has(page)) return;
    pages.add(page);
    const target = targetOf(page);
    if (target) pageByTarget.set(target, page);
    if (page !== initialPage) {
      try { onPage(page); } catch {}
    }
  };

  const rememberInitialLineage = () => {
    let changed;
    do {
      changed = false;
      for (const page of initialLineagePages) {
        const target = targetOf(page);
        if (target && !initialLineageTargets.has(target)) {
          initialLineageTargets.add(target);
          changed = true;
        }
        let opener;
        try { opener = target?.opener?.(); } catch {}
        if (!opener) continue;
        if (!initialLineageTargets.has(opener)) {
          initialLineageTargets.add(opener);
          changed = true;
        }
        const openerPage = pageByTarget.get(opener);
        if (openerPage && !initialLineagePages.has(openerPage)) {
          initialLineagePages.add(openerPage);
          changed = true;
        }
      }
      for (const page of pages) {
        const target = targetOf(page);
        let opener;
        try { opener = target?.opener?.(); } catch {}
        if (!target || !opener || !initialLineageTargets.has(opener)) continue;
        if (!initialLineagePages.has(page)) {
          initialLineagePages.add(page);
          changed = true;
        }
        if (!initialLineageTargets.has(target)) {
          initialLineageTargets.add(target);
          changed = true;
        }
      }
    } while (changed);
  };

  const rememberFlowPage = page => {
    loginFlowPages.add(page);
    let target = targetOf(page);
    if (target) flowOriginTargets.add(target);
    const visited = new Set(target ? [target] : []);
    while (target) {
      let opener;
      try { opener = target.opener?.(); } catch {}
      if (!opener || visited.has(opener)) break;
      visited.add(opener);
      flowAncestorTargets.add(opener);
      const openerPage = pageByTarget.get(opener);
      if (openerPage) flowAncestorPages.add(openerPage);
      target = opener;
    }
  };

  const rememberFlowDescendants = () => {
    let changed;
    do {
      changed = false;
      for (const page of pages) {
        const target = targetOf(page);
        if (!target || flowOriginTargets.has(target) || flowDescendantTargets.has(target)) continue;
        let opener;
        try { opener = target.opener?.(); } catch {}
        if (opener && (flowOriginTargets.has(opener) || flowAncestorTargets.has(opener) || flowDescendantTargets.has(opener))) {
          flowDescendantTargets.add(target);
          flowDescendantPages.add(page);
          changed = true;
        }
      }
    } while (changed);
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
        rememberInitialLineage();
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
      const activeLoginFlow = relevantStates.some(({ page, state }) => initialLineagePages.has(page) &&
        (state.loginFormVisible || state.challengeVisible));
      for (const { page, state } of relevantStates) {
        if (initialLineagePages.has(page) && (state.loginFormVisible || state.challengeVisible)) rememberFlowPage(page);
      }
      rememberFlowDescendants();

      const flowTransitionPending = relevantStates.some(({ page, state }) => loginFlowPages.has(page) &&
        !state.publicLanding && !state.authenticated && !state.loginFormVisible && !state.challengeVisible);

      // Ignore pre-existing unrelated public tabs, but follow popup tabs and
      // opener pages linked to the observed login flow. This covers Seller Hub
      // returns that land in a new tab after the form tab closes.
      const returnedPages = new Set(!activeLoginFlow
        ? relevantStates
          .filter(({ page, state }) => state.publicLanding && (
            loginFlowPages.has(page) || flowDescendantPages.has(page) ||
            (flowAncestorPages.has(page) && !flowTransitionPending)
          ))
          .map(({ page }) => page)
        : []);
      for (const page of publicReturnSince.keys()) {
        if (!returnedPages.has(page)) publicReturnSince.delete(page);
      }
      for (const page of returnedPages) {
        if (!publicReturnSince.has(page)) publicReturnSince.set(page, now());
      }

      const stableReturnPages = new Set([...returnedPages].filter(page =>
        now() - publicReturnSince.get(page) >= publicReturnGraceMs));
      for (const { page, state } of pageStates) {
        if (!initialLineagePages.has(page)) continue;
        const confirmedReturn = stableReturnPages.has(page);
        const stage = confirmedReturn ? 'public_return' : returnedPages.has(page) ? 'public_return_pending' : state.stage;
        const stateForUi = { ...state, stage, ...(confirmedReturn ? { returnConfirmed: true } : {}) };
        const signature = JSON.stringify(stateForUi);
        if (reportedStates.get(page) === signature) continue;
        reportedStates.set(page, signature);
        try { onState(page, stateForUi); } catch {}
      }

      if (stableReturnPages.size > 0) {
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
