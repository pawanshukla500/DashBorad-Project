import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactDiagnosticText } from './structuredLogger.js';

const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_SCREENSHOTS = 20;
const SENSITIVE_CONTROLS = 'input,textarea,select,[contenteditable="true"],[role="textbox"]';

async function screenshotWithMaskedControls(page) {
  if (typeof page?.evaluate !== 'function') throw new Error('Screenshot skipped because editable controls could not be redacted.');
  let snapshot;
  try {
    snapshot = await page.evaluate(selector => Array.from(document.querySelectorAll(selector)).map(element => {
      const style = element.getAttribute('style');
      element.style.setProperty('color', 'transparent', 'important');
      element.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
      element.style.setProperty('text-shadow', 'none', 'important');
      element.style.setProperty('caret-color', 'transparent', 'important');
      element.style.setProperty('filter', 'blur(8px)', 'important');
      return style;
    }), SENSITIVE_CONTROLS);
  } catch {
    throw new Error('Screenshot skipped because editable controls could not be redacted.');
  }
  if (!Array.isArray(snapshot)) throw new Error('Screenshot skipped because editable controls could not be redacted.');
  try {
    return await page.screenshot();
  } finally {
    if (snapshot.length) {
      await page.evaluate(({ selector, styles }) => {
        Array.from(document.querySelectorAll(selector)).forEach((element, index) => {
          const style = styles[index];
          if (style == null) element.removeAttribute('style');
          else element.setAttribute('style', style);
        });
      }, { selector: SENSITIVE_CONTROLS, styles: snapshot }).catch(() => {});
    }
  }
}

function boundDiagnostics(directory) {
  const logPath = path.join(directory, 'errors.jsonl');
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    let kept = '';
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index] + '\n';
      if (Buffer.byteLength(kept) + Buffer.byteLength(line) > MAX_DIAGNOSTIC_BYTES) break;
      kept = line + kept;
    }
    fs.writeFileSync(logPath, kept, { mode: 0o600 });
  } catch {}
  try {
    const screenshots = fs.readdirSync(directory)
      .filter(name => /^failure-.*\.png$/i.test(name))
      .map(name => ({ name, mtime: fs.statSync(path.join(directory, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const item of screenshots.slice(MAX_SCREENSHOTS)) fs.rmSync(path.join(directory, item.name), { force: true });
  } catch {}
}

export async function captureScrapeFailure(page, directory, context, error) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = `failure-${Date.now()}-${randomUUID()}`;
  const diagnostic = { timestamp: new Date().toISOString(), ...context,
    code: redactDiagnosticText(error.code || 'EXTRACTION_REJECTED').slice(0, 120),
    message: redactDiagnosticText(error.message).slice(0, 12000) };
  try {
    const url = new URL(page?.url());
    diagnostic.url = `${url.origin}${url.pathname}${url.hash.split('?')[0]}`;
  } catch {}
  try {
    if (page?.screenshot) {
      const screenshot = `${id}.png`;
      fs.writeFileSync(path.join(directory, screenshot), await screenshotWithMaskedControls(page), { mode: 0o600 });
      diagnostic.screenshot = screenshot;
    }
  } catch (err) { diagnostic.screenshotError = redactDiagnosticText(err.message).slice(0, 1200); }
  // Metadata only: never persist response bodies, cookies, tokens or input values.
  fs.appendFileSync(path.join(directory, 'errors.jsonl'), `${JSON.stringify(diagnostic)}\n`, { mode: 0o600 });
  boundDiagnostics(directory);
  return diagnostic;
}
