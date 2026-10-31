import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactDiagnosticText } from './structuredLogger.js';

const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_SCREENSHOTS = 20;

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
      fs.writeFileSync(path.join(directory, screenshot), await page.screenshot(), { mode: 0o600 });
      diagnostic.screenshot = screenshot;
    }
  } catch (err) { diagnostic.screenshotError = err.message; }
  // Metadata only: never persist response bodies, cookies, tokens or input values.
  fs.appendFileSync(path.join(directory, 'errors.jsonl'), `${JSON.stringify(diagnostic)}\n`, { mode: 0o600 });
  boundDiagnostics(directory);
  return diagnostic;
}
