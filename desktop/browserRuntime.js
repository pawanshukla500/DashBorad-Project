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

export async function focusBrowserPage(page, { delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!page || typeof page.bringToFront !== 'function') return false;
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
