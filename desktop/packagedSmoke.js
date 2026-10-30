import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createEmbeddedPage } from './embeddedBrowser.js';
import { portalPartition } from './portalSession.js';
import { getStagingDb, stageReview, recoverReview, closeStagingDb } from './localStaging.js';

export async function runPackagedSmoke({ app, window, output, setPage, nativeImage }) {
  const result = { platform: process.platform, version: app.getVersion(), packaged: app.isPackaged, checks: [] };
  const check = (condition, label) => { if (!condition) throw new Error(label); result.checks.push(label); };
  let server, page;
  try {
    check(app.isPackaged, 'Running the installed packaged application');
    const root = app.getAppPath();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
    for (const [file, digest] of Object.entries(manifest.files)) {
      check(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') === digest, `Packaged source hash: ${file}`);
    }
    check(/^[0-9a-f]{40}$/.test(manifest.commit) && !manifest.dirty, 'Clean source commit recorded in installed release');
    result.commit = manifest.commit;
    if (process.env.RECON_EXPECT_COMMIT) check(result.commit === process.env.RECON_EXPECT_COMMIT, 'Installed commit matches requested commit');
    if (window.webContents.isLoading()) await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    check(await window.webContents.executeJavaScript('Boolean(window.ratecardAPI?.setMonitorDockBounds)'), 'Sandboxed preload bridge loaded');
    const denied = await window.webContents.executeJavaScript('window.ratecardAPI.captureBrowserScreenshot()');
    check(denied.success === false, 'Screenshot IPC rejects an unauthenticated renderer');
    server = http.createServer((_req, res) => {
      res.setHeader('Set-Cookie', 'smoke_session=fixture; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax');
      res.end('<!doctype html><html><head><title>Packaged Chromium test</title></head><body style="background:#902A4A;color:white"><h1>Live browser</h1><label>OTP <input id="otp" autocomplete="one-time-code"></label><a href="#ready">Continue</a><div style="width:180px;height:80px;background:#fbe9f0">Rendered frame</div></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    page = createEmbeddedPage({ window, partition: portalPartition('flipkart'), bounds: { x: 20, y: 120, width: 550, height: 380 }, visible: true });
    setPage(page);
    await page.goto(url);
    check(page._view.getBounds().width === 550 && page._view.getVisible(), 'Real WebContentsView is attached with nonzero bounds and visible');
    page.setVisible(false);
    await page.type('#otp', '123456', { delay: 10 });
    check(await page.evaluate(() => document.querySelector('#otp').value) === '123456', 'Hidden renderer accepts real OTP editor input');
    page.setVisible(true);
    await window.webContents.executeJavaScript('window.ratecardAPI.setMonitorDockBounds({x:30,y:150,width:420,height:280})');
    check(page._view.getBounds().x === 30 && page._view.getBounds().width === 420, 'Renderer dock IPC updates native bounds');
    const png = await page.screenshot();
    fs.writeFileSync(`${output}.png`, png);
    check(png.length > 1000, 'Real Chromium screenshot is nonempty');
    const bitmap = nativeImage.createFromBuffer(png).getBitmap();
    const colors = new Set();
    for (let i = 0; i < bitmap.length; i += 4 * 19) colors.add(bitmap.subarray(i, i + 4).toString('hex'));
    check(colors.size > 8, 'Rendered Chromium frame contains content, not a blank surface');
    const link = await page.evaluate(() => { const rect = document.querySelector('a').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
    page._contents.focus();
    page._contents.sendInputEvent({type:'mouseDown',x:Math.round(link.x),y:Math.round(link.y),button:'left',clickCount:1});
    page._contents.sendInputEvent({type:'mouseUp',x:Math.round(link.x),y:Math.round(link.y),button:'left',clickCount:1});
    await new Promise(resolve => setTimeout(resolve, 1000));
    check(page.url().endsWith('#ready'), 'Real embedded mouse click navigates the live page');
    const cookies = await page.cookies();
    check(cookies.some(c => c.name === 'smoke_session' && c.httpOnly), 'Real Chromium session preserves HttpOnly cookies');
    await page.close(); page = null;
    page = createEmbeddedPage({ window, partition: portalPartition('shopsy'), bounds: { x: 20, y: 120, width: 550, height: 380 } });
    check((await page.cookies()).some(c => c.name === 'smoke_session'), 'Flipkart and Shopsy share the authenticated portal partition');
    const card = { marketplace: 'flipkart', category: 'fixture', commissions: [{ price_min: 0, price_max: 500, rate: 0.1 }] };
    stageReview(getStagingDb(app.getPath('userData')), 'packaged-review', 'fixture-owner', 'flipkart', [card]);
    closeStagingDb();
    check(recoverReview(getStagingDb(app.getPath('userData')), 'fixture-owner').cards[0].category === 'fixture', 'Packaged SQLite WASM and durable review recovery work');
    result.success = true;
  } catch (error) { result.success = false; result.error = error.message; }
  finally {
    await page?.close().catch(() => {});
    closeStagingDb();
    server?.close();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    app.exit(result.success ? 0 : 1);
  }
}
