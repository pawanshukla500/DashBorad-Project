function getChildProcess(browser) {
  try { return typeof browser?.process === 'function' ? browser.process() : null; }
  catch { return null; }
}

function childHasExited(child) {
  return Boolean(child && (child.exitCode !== null || child.signalCode !== null));
}

export function isBrowserProcessExited(browser) {
  const child = getChildProcess(browser);
  if (!child) {
    try { return typeof browser?.isConnected === 'function' && !browser.isConnected(); }
    catch { return false; }
  }
  return childHasExited(child);
}

export function watchBrowserProcessExit(browser, onExit) {
  const child = getChildProcess(browser);
  if (!child || typeof child.once !== 'function') return () => {};
  let active = true;
  const handleExit = () => {
    if (!active) return;
    active = false;
    onExit();
  };
  if (childHasExited(child)) {
    queueMicrotask(handleExit);
    return () => { active = false; };
  }
  child.once('exit', handleExit);
  return () => {
    active = false;
    child.removeListener?.('exit', handleExit);
  };
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true);
  if (!child || typeof child.once !== 'function') return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = exited => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.('exit', onExit);
      resolve(exited || childHasExited(child));
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    child.once('exit', onExit);
    if (childHasExited(child)) finish(true);
  });
}

function browserIsConnected(browser) {
  try { return typeof browser?.isConnected !== 'function' || browser.isConnected(); }
  catch { return false; }
}

/**
 * Close an app-launched Chromium process and verify its child has exited before
 * allowing its persistent profile lease to be released. If CDP disconnected
 * first, terminate only the child process owned by Puppeteer.
 */
export async function closeOwnedBrowserProcess(browser, {
  closeTimeoutMs = 8000,
  exitTimeoutMs = 3000,
  terminateTimeoutMs = 5000,
  closeArgs = []
} = {}) {
  if (!browser) return true;
  const child = getChildProcess(browser);
  let closeError = null;
  let closeSucceeded = false;

  if (browserIsConnected(browser)) {
    let closeTimer;
    const closeResult = await Promise.race([
      Promise.resolve().then(() => browser.close(...closeArgs)).then(
        () => 'closed',
        error => { closeError = error; return 'failed'; }
      ),
      new Promise(resolve => { closeTimer = setTimeout(() => resolve('timeout'), closeTimeoutMs); })
    ]);
    clearTimeout(closeTimer);
    closeSucceeded = closeResult === 'closed';
    if (closeResult === 'timeout' && !closeError) {
      closeError = new Error('Timed out while closing the Seller Hub browser.');
    }
  }

  if (child && !childHasExited(child)) {
    if (!await waitForChildExit(child, exitTimeoutMs)) {
      try { child.kill(); } catch (error) { closeError ||= error; }
      if (!await waitForChildExit(child, terminateTimeoutMs)) {
        const error = new Error('Seller Hub Chromium is still running; its profile remains locked.');
        if (closeError) error.cause = closeError;
        throw error;
      }
    }
  }

  if (!child) {
    if (typeof browser.isConnected === 'function') {
      if (!browserIsConnected(browser)) return true;
      if (closeError) throw closeError;
      throw new Error('Seller Hub Chromium remained connected after close; its profile remains locked.');
    }
    if (closeSucceeded) return true;
    if (closeError) throw closeError;
    const error = new Error('Seller Hub Chromium close could not be confirmed; its profile remains locked.');
    throw error;
  }

  if (browserIsConnected(browser) && !childHasExited(child)) {
    const error = new Error('Seller Hub Chromium remained connected after close; its profile remains locked.');
    if (closeError) error.cause = closeError;
    throw error;
  }
  return true;
}
