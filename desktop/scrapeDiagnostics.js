import fs from 'node:fs';
import path from 'node:path';

export async function captureScrapeFailure(page, directory, context, error) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = `failure-${Date.now()}`;
  const diagnostic = { timestamp: new Date().toISOString(), ...context,
    code: error.code || 'EXTRACTION_REJECTED', message: error.message };
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
  return diagnostic;
}
