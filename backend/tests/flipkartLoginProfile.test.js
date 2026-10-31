import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getFlipkartBrowserProfileDir } from '../services/flipkartBrowserProfile.js';
import { resolveDesktopUserDataDir } from '../../desktop/userDataPaths.js';
import { getFlipkartVerticals } from '../services/flipkartRateCardExtractor.js';
import { scrapeRateCard } from '../services/rateCardScraper.js';
import { loadEncryptedCookies as loadBackendCookies, saveEncryptedCookies as saveBackendCookies } from '../utils/cookieVault.js';
import { loadEncryptedCookies as loadDesktopCookies, saveEncryptedCookies as saveDesktopCookies } from '../../desktop/cookieVault.js';

describe('Flipkart persistent Seller Hub login', () => {
  it('uses the desktop app profile on Windows', () => {
    const appData = path.join(os.tmpdir(), 'reconcentral-test-roaming');
    expect(getFlipkartBrowserProfileDir({ env: { APPDATA: appData }, platform: 'win32' }))
      .toBe(path.join(appData, 'ReconCentral RateCard Worker', 'browser-profiles', 'flipkart_shopsy'));
    expect(resolveDesktopUserDataDir({ env: { APPDATA: appData }, platform: 'win32' }))
      .toBe(path.join(appData, 'ReconCentral RateCard Worker'));
  });

  it('honors the user-data directory supplied by the running desktop app', () => {
    const userData = path.join(os.tmpdir(), 'desktop-user-data');
    expect(getFlipkartBrowserProfileDir({ env: { RECON_USER_DATA_DIR: userData, APPDATA: 'ignored' }, platform: 'win32' }))
      .toBe(path.join(userData, 'browser-profiles', 'flipkart_shopsy'));
  });

  it('honors the standalone desktop server user-data override', () => {
    const userData = path.join(os.tmpdir(), 'desktop-server-user-data');
    expect(getFlipkartBrowserProfileDir({ env: { RECONCENTRAL_USER_DATA: userData, APPDATA: 'ignored' }, platform: 'win32' }))
      .toBe(path.join(userData, 'browser-profiles', 'flipkart_shopsy'));
  });

  it('resolves Linux app profiles from XDG_CONFIG_HOME or HOME', () => {
    const xdg = path.join(os.tmpdir(), 'xdg-config');
    const home = path.join(os.tmpdir(), 'linux-home');
    expect(getFlipkartBrowserProfileDir({ env: { XDG_CONFIG_HOME: xdg, HOME: home }, platform: 'linux' }))
      .toBe(path.join(xdg, 'reconcentral-ratecard-worker', 'browser-profiles', 'flipkart_shopsy'));
    expect(getFlipkartBrowserProfileDir({ env: { HOME: home }, platform: 'linux' }))
      .toBe(path.join(home, '.config', 'reconcentral-ratecard-worker', 'browser-profiles', 'flipkart_shopsy'));
  });

  it('reuses the legacy Windows Seller Hub profile only when it has Chromium stores', () => {
    const appData = path.join(os.tmpdir(), 'reconcentral-legacy-roaming');
    const legacyProfile = path.join(appData, 'reconcentral-ratecard-worker', 'browser-profiles', 'flipkart_shopsy');
    const canonicalProfile = path.join(appData, 'ReconCentral RateCard Worker', 'browser-profiles', 'flipkart_shopsy');
    const legacyCookieStore = path.join(legacyProfile, 'Default', 'Network', 'Cookies');
    const existing = new Set([legacyCookieStore]);
    const options = { env: { APPDATA: appData }, platform: 'win32', existsSync: candidate => existing.has(candidate) };

    expect(getFlipkartBrowserProfileDir(options)).toBe(legacyProfile);
    existing.add(path.join(canonicalProfile, 'Default', 'Cookies'));
    expect(getFlipkartBrowserProfileDir(options)).toBe(canonicalProfile);
  });

  it('does not search legacy profiles when an explicit user-data override is supplied', () => {
    const appData = path.join(os.tmpdir(), 'reconcentral-override-roaming');
    const userData = path.join(os.tmpdir(), 'explicit-reconcentral-user-data');
    const legacyCookieStore = path.join(appData, 'reconcentral-ratecard-worker', 'browser-profiles', 'flipkart_shopsy', 'Default', 'Cookies');
    expect(getFlipkartBrowserProfileDir({
      env: { APPDATA: appData, RECON_USER_DATA_DIR: userData },
      platform: 'win32',
      existsSync: candidate => candidate === legacyCookieStore
    })).toBe(path.join(userData, 'browser-profiles', 'flipkart_shopsy'));
  });

  it('treats an explicit profile root as isolated unless legacy reuse is requested', () => {
    const appData = path.join(os.tmpdir(), 'reconcentral-isolated-roaming');
    const userData = path.join(os.tmpdir(), 'isolated-user-data');
    const legacyCookieStore = path.join(appData, 'reconcentral-ratecard-worker', 'browser-profiles', 'flipkart_shopsy', 'Default', 'Cookies');
    expect(getFlipkartBrowserProfileDir({
      env: { APPDATA: appData },
      platform: 'win32',
      userDataDir: userData,
      existsSync: candidate => candidate === legacyCookieStore
    })).toBe(path.join(userData, 'browser-profiles', 'flipkart_shopsy'));
  });

  it('keeps the sign-in helper manual, root-only, and persistent', () => {
    const helper = fs.readFileSync(new URL('../scripts/open_live_logged_in_browser.js', import.meta.url), 'utf8');
    expect(helper).toContain('FLIPKART_MANUAL_LOGIN_URL');
    expect(helper).toContain('userDataDir: profileDir');
    expect(helper).toContain('Click Login');
    expect(helper).toContain('waitForFlipkartAuthenticatedPage(browser');
    expect(helper).toContain('onPage: observePage');
    expect(helper).toContain('loginMonitorAbort.abort()');
    expect(helper).not.toMatch(/FK_ID|FK_PASSWORD|cookies\.json|page\.setCookie|referral_url/);
  });

  it('rejects and removes plaintext cookie snapshots in both runtimes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipkart-cookie-security-'));
    try {
      for (const [index, loader] of [loadBackendCookies, loadDesktopCookies].entries()) {
        const file = path.join(tempDir, `plaintext-${index}.json`);
        fs.writeFileSync(file, JSON.stringify([{ name: 'session', value: 'fixture-only', domain: '.flipkart.com' }]));
        expect(loader(file)).toBeNull();
        expect(fs.existsSync(file)).toBe(false);
      }
      for (const [index, loader] of [loadBackendCookies, loadDesktopCookies].entries()) {
        const target = path.join(tempDir, `cookies_flipkart_${index}.json`);
        const legacyFallback = path.join(tempDir, 'cookies.json');
        fs.writeFileSync(legacyFallback, JSON.stringify([{ name: 'session', value: 'fixture-only', domain: '.flipkart.com' }]));
        expect(loader(target)).toBeNull();
        expect(fs.existsSync(legacyFallback)).toBe(false);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('removes plaintext fallback files even when an encrypted target already exists', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipkart-cookie-fallback-cleanup-'));
    const fixtureCookies = [{ name: 'fixture-session', value: 'encrypted-fixture', domain: '.flipkart.com' }];
    try {
      for (const [index, [loader, saver]] of [[loadBackendCookies, saveBackendCookies], [loadDesktopCookies, saveDesktopCookies]].entries()) {
        const channelDir = path.join(tempDir, `runtime-${index}`);
        fs.mkdirSync(channelDir, { recursive: true });
        const encryptedTarget = path.join(channelDir, 'cookies_flipkart.json');
        const plaintextFallback = path.join(channelDir, 'cookies.json');
        saver(encryptedTarget, fixtureCookies);
        const encryptedBefore = fs.readFileSync(encryptedTarget, 'utf8');
        fs.writeFileSync(plaintextFallback, JSON.stringify(fixtureCookies));

        expect(loader(encryptedTarget)).toEqual(fixtureCookies);
        expect(fs.existsSync(plaintextFallback)).toBe(false);
        expect(fs.readFileSync(encryptedTarget, 'utf8')).toBe(encryptedBefore);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('removes the repository-root plaintext cookie file when started from the backend directory', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flipkart-root-cookie-cleanup-'));
    const backendDir = path.join(repoRoot, 'backend');
    const sourceDir = path.join(backendDir, 'utils');
    const userDataDir = path.join(repoRoot, 'app-data');
    const legacyRuntimeDir = path.join(repoRoot, '.runtime');
    const modulePath = path.join(sourceDir, 'cookieVault.js');
    const encryptedTarget = path.join(userDataDir, 'cookies_flipkart.json');
    const plaintextFallback = path.join(legacyRuntimeDir, 'cookies.json');
    const runnerPath = path.join(repoRoot, 'run-vault-test.mjs');
    const runnerSource = `
      import fs from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const [, , modulePath, targetPath, fallbackPath] = process.argv;
      const vault = await import(pathToFileURL(modulePath).href);
      const fixtureCookies = [{ name: 'fixture-session', value: 'test-only', domain: '.flipkart.com' }];
      vault.saveEncryptedCookies(targetPath, fixtureCookies);
      const encryptedBefore = fs.readFileSync(targetPath, 'utf8');
      fs.writeFileSync(fallbackPath, JSON.stringify(fixtureCookies));
      const loaded = vault.loadEncryptedCookies(targetPath);
      const encryptedUnchanged = fs.readFileSync(targetPath, 'utf8') === encryptedBefore;
      process.stdout.write(JSON.stringify({ loaded, fallbackExists: fs.existsSync(fallbackPath), encryptedUnchanged }));
    `;

    try {
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(legacyRuntimeDir, { recursive: true });
      fs.writeFileSync(path.join(backendDir, 'package.json'), '{"type":"module"}');
      fs.copyFileSync(new URL('../utils/cookieVault.js', import.meta.url), modulePath);
      fs.writeFileSync(runnerPath, runnerSource);
      const childEnv = { RECON_USER_DATA_DIR: userDataDir };
      for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME']) {
        if (process.env[name]) childEnv[name] = process.env[name];
      }
      const result = JSON.parse(execFileSync(process.execPath, [runnerPath, modulePath, encryptedTarget, plaintextFallback], {
        cwd: backendDir,
        env: childEnv,
        encoding: 'utf8'
      }));

      expect(result.loaded).toEqual([{ name: 'fixture-session', value: 'test-only', domain: '.flipkart.com' }]);
      expect(result.fallbackExists).toBe(false);
      expect(result.encryptedUnchanged).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('disables legacy scripts that replayed plaintext Seller Hub cookies or wrote directly to PostgreSQL', () => {
    for (const relativePath of ['../scripts/check_new_category.js', '../scripts/live_interactive_visual_tour.js']) {
      const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source).toContain('Disabled:');
      expect(source).not.toMatch(/puppeteer|\.setCookie\(|syncRateCardsToDatabase|forceUpdate|cookies\.json|readFileSync|readFile\(/i);
    }
  });

  it('does not invent categories when the database has no configured rows', async () => {
    const categories = await getFlipkartVerticals({ query: async () => ({ rows: [] }) });
    expect(categories).toEqual([]);
  });

  it('surfaces missing category-table/database errors instead of substituting categories', async () => {
    await expect(getFlipkartVerticals({ query: async () => { throw new Error('relation orders does not exist'); } }))
      .rejects.toThrow('Unable to read configured Flipkart categories');
  });

  it('disables the legacy direct database scraper instead of writing sample fee values', async () => {
    const result = await scrapeRateCard();
    expect(result.success).toBe(false);
    expect(result.error).toContain('desktop worker extraction and review workflow');
  });
});
