import { createRequire } from 'node:module';
import fs from 'node:fs';
import { getChromeExecutablePath } from './chromeFinder.js';

const require = createRequire(import.meta.url);
let runtime;

// Explicitly bind the driver. puppeteer-extra's optional peer lookup can otherwise
// succeed in the repository but fail inside a production-only app.asar.
export function getBrowserRuntime() {
  if (!runtime) {
    const { addExtra } = require('puppeteer-extra');
    runtime = addExtra(require('puppeteer-core'));
    runtime.use(require('puppeteer-extra-plugin-stealth')());
  }
  return runtime;
}

export function requireChromeExecutable() {
  const executable = getChromeExecutablePath();
  if (!executable || !fs.existsSync(executable)) {
    throw new Error('Chrome or Microsoft Edge was not found. Install a supported browser or set CHROME_BIN, then restart the worker.');
  }
  return executable;
}

export function canOpenVisibleBrowser() {
  if (process.platform !== 'linux') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export function resolveVisibleBrowserViewport({
  currentWidth = 0,
  currentHeight = 0,
  availableWidth = 0,
  availableHeight = 0
} = {}) {
  const screenWidth = Number(availableWidth) || 1472;
  const screenHeight = Number(availableHeight) || 980;
  const maxWidth = Math.min(1440, Math.max(1, Math.floor(screenWidth - 32)));
  const maxHeight = Math.min(900, Math.max(1, Math.floor(screenHeight - 80)));
  const minimumWidth = Math.min(1280, maxWidth);
  const minimumHeight = Math.min(760, maxHeight);
  if (currentWidth >= minimumWidth && currentHeight >= minimumHeight &&
      currentWidth <= maxWidth && currentHeight <= maxHeight) return null;

  return {
    // Puppeteer can keep its default 800x600 CSS viewport even when the Chrome
    // window itself is maximized. Seller Hub hides the existing-seller Login
    // control at that breakpoint, so use the largest desktop viewport that
    // leaves room for the browser chrome while keeping smaller displays usable.
    width: maxWidth,
    height: maxHeight
  };
}

export async function ensureVisibleBrowserViewport(page, { delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!page || typeof page.evaluate !== 'function' || typeof page.setViewport !== 'function') return false;
  let metrics;
  try {
    metrics = await page.evaluate(() => ({
      currentWidth: window.innerWidth,
      currentHeight: window.innerHeight,
      availableWidth: window.screen?.availWidth,
      availableHeight: window.screen?.availHeight
    }));
  } catch {
    return false;
  }

  const viewport = resolveVisibleBrowserViewport(metrics || {});
  if (!viewport) return false;
  // Keep the same minimum spacing used by the Seller Hub navigation and
  // readiness checks when changing the page's visible layout.
  await delay(1000);
  await page.setViewport(viewport);
  return viewport;
}

export async function focusBrowserPage(page, {
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onViewport = () => {}
} = {}) {
  if (!page || typeof page.bringToFront !== 'function') return false;
  const viewport = await ensureVisibleBrowserViewport(page, { delay });
  if (viewport) {
    try { await onViewport(viewport); } catch {}
  }
  await delay(1000);
  await page.bringToFront();
  // Leave a full interaction interval before the caller navigates or polls.
  await delay(1000);
  return true;
}

export async function withBrowserTask(task) {
  if (withBrowserTask.busy) {
    return { success: false, error: 'A browser task is already running. Finish login or extraction before starting another.' };
  }
  withBrowserTask.busy = true;
  try {
    return await task();
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    withBrowserTask.busy = false;
  }
}
