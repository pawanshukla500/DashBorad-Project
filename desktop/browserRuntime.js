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
