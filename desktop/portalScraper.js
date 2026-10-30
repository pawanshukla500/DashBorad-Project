import fs from 'node:fs';
import path from 'node:path';
import { getBrowserRuntime, requireChromeExecutable } from './browserRuntime.js';
import { getResolvedUserDataDir, loadEncryptedCookies, saveEncryptedCookies, deleteEncryptedCookies } from './cookieVault.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseRateCardTables(tables, vertical, effectiveDate, marketplace = 'flipkart') {
  const isShopsy = marketplace === 'shopsy' || vertical.toLowerCase().startsWith('shopsy_');
  const parsed = {
    marketplace: isShopsy ? 'shopsy' : 'flipkart', vertical, effectiveDate,
    commissions: [], fixedFees: [], collectionFees: [], reverseShipping: []
  };
  const parseAmount = (value) => parseFloat(String(value || '').replace(/[₹%,]/g, '').trim()) || 0;
  const parsePriceRange = (value) => {
    const text = String(value || '').replace(/[₹,]/g, '').trim();
    if (text.startsWith('>=')) return { min: parseAmount(text.slice(2)), max: 999999 };
    if (text.startsWith('>')) return { min: parseAmount(text.slice(1)) + 0.01, max: 999999 };
    if (text.includes('-')) {
      const [min, max] = text.split('-').map(parseAmount);
      return { min, max: max || 999999 };
    }
    return { min: parseAmount(text), max: 999999 };
  };
  const tiers = ['Bronze', 'Silver', 'Gold', 'Diamond'];
  if (isShopsy) {
    parsed.commissions.push({ price_min: 0, price_max: 999999, rate: 0 });
    for (const tier of tiers) {
      parsed.fixedFees.push(
        { fulfilment_type: tier, price_min: 0, price_max: 1500, rate: 0 },
        { fulfilment_type: tier, price_min: 1501, price_max: 999999, rate: 10 }
      );
    }
    for (const [weight_slab, fees] of [
      ['0kg-0.5kg', [[0, 500, 122, 142, 182], [501, 1000, 147, 167, 207], [1001, 999999, 157, 177, 217]]],
      ['0.5kg-1kg', [[0, 500, 152, 177, 227], [501, 1000, 177, 202, 252], [1001, 999999, 187, 212, 262]]]
    ]) {
      for (const [price_min, price_max, local_fee, zonal_fee, national_fee] of fees) {
        parsed.reverseShipping.push({ weight_slab, price_min, price_max, local_fee, zonal_fee, national_fee });
      }
    }
    return parsed;
  }
  for (const table of tables) {
    if (!table?.length) continue;
    const header = table[0].join(' ').toLowerCase();
    if (header.includes('order item value') && header.includes('fee charged')) {
      const percentage = table.some((row) => row.some((cell) => cell.includes('%')));
      for (const row of table.slice(1)) {
        if (row.length < 2) continue;
        const range = parsePriceRange(row[0]);
        if (percentage) {
          parsed.commissions.push({ price_min: range.min, price_max: range.max, rate: parseAmount(row[1]) / 100 });
        } else {
          for (const tier of tiers) {
            parsed.fixedFees.push({ fulfilment_type: tier, price_min: range.min, price_max: range.max, rate: parseAmount(row[1]) });
          }
        }
      }
    }
    if (header.includes('prepaid') && header.includes('postpaid')) {
      for (const row of table.slice(1)) {
        if (row.length < 3) continue;
        const range = parsePriceRange(row[0]);
        parsed.collectionFees.push({
          price_min: range.min, price_max: range.max,
          prepaid: parseAmount(row[1]), postpaid: parseAmount(row[2]),
          prepaid_type: row[1].includes('%') ? 'percentage' : 'flat',
          postpaid_type: row[2].includes('%') ? 'percentage' : 'flat',
          fulfilment_type: 'All'
        });
      }
    }
    if (header.includes('weight') && (header.includes('local') || header.includes('base rates'))) {
      let weightSlab = '0kg-0.5kg';
      for (const row of table) {
        const slab = row.join(' ').match(/(\d+(?:\.\d+)?\s*kg\s*-\s*\d+(?:\.\d+)?\s*kg)/i);
        if (slab) weightSlab = slab[1].replace(/\s+/g, '');
        const prices = row.filter((cell) => /₹\d+/.test(cell));
        if (prices.length < 3) continue;
        const range = parsePriceRange(row.find((cell) => /₹\d+\s*-\s*₹\d+|>=?\s*₹\d+/.test(cell)) || '₹0 - ₹999999');
        const [local_fee, zonal_fee, national_fee] = prices.slice(-3).map((cell) => {
          const amount = cell.match(/₹(\d+(?:\.\d+)?)/);
          return amount ? Number(amount[1]) : 0;
        });
        parsed.reverseShipping.push({
          weight_slab: weightSlab, price_min: range.min, price_max: range.max,
          local_fee, zonal_fee, national_fee
        });
      }
    }
  }
  return parsed;
}

/**
 * Self-contained portal extraction for both Electron and the Linux server.
 * Runtime injection keeps the full extraction lifecycle testable offline.
 */
export async function scrapeFlipkartRateCards(config = {}, {
  onProgress = console.log,
  cookiesPath = path.join(getResolvedUserDataDir(), 'cookies', 'cookies_flipkart_shopsy.json'),
  fallbackCookiesPath = path.join(getResolvedUserDataDir(), 'cookies.json'),
  stagingDir = path.join(getResolvedUserDataDir(), 'staging'),
  runtime = getBrowserRuntime(),
  executablePath,
  delay = wait,
  onSessionExpiry
} = {}) {
  const marketplace = config.marketplace || 'both';
  if (!['both', 'flipkart_shopsy', 'flipkart', 'shopsy'].includes(marketplace)) {
    return { success: false, error: `Automated scraping is not implemented for ${marketplace}.` };
  }
  let browser;
  try {
    browser = await runtime.launch({
      executablePath: executablePath || (runtime?.partition ? undefined : requireChromeExecutable()),
      headless: config.visible ? false : 'new',
      defaultViewport: config.visible ? null : { width: 1500, height: 1000 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        ...(config.visible ? ['--start-maximized'] : ['--window-size=1500,1000'])
      ]
    });
    const page = (await browser.pages())[0] || await browser.newPage();
    const cookieFile = fs.existsSync(cookiesPath) ? cookiesPath : fallbackCookiesPath;
    if (fs.existsSync(cookieFile)) {
      const cookies = loadEncryptedCookies(cookieFile);
      if (cookies?.length) {
        await page.setCookie(...cookies);
      } else {
        deleteEncryptedCookies(cookieFile);
      }
    }
    const safeGoto = async (targetUrl, options = {}) => {
      try {
        return await page.goto(targetUrl, { waitUntil: 'load', timeout: 35000, ...options });
      } catch (navErr) {
        const msg = String(navErr?.message || navErr);
        if (msg.includes('ERR_ABORTED') || navErr?.code === 'ERR_ABORTED' || navErr?.errno === -3) {
          return { ok: true, redirected: true };
        }
        if (msg.includes('quiet network state')) {
          return { ok: true, quietTimeout: true };
        }
        throw navErr;
      }
    };

    // Step 1: Navigate to seller.flipkart.com landing page first
    onProgress('Connecting to Flipkart Seller Hub (https://seller.flipkart.com/)...');
    await safeGoto('https://seller.flipkart.com/', { waitUntil: 'load', timeout: 35000 });
    await delay(1500);

    const checkSession = () => page.evaluate(() => {
      const href = window.location.href.toLowerCase();
      const body = document.body?.innerText.toLowerCase() || '';
      const hasPassword = Boolean(document.querySelector('input[type="password"]'));
      return !hasPassword && (
        href.includes('#dashboard') ||
        href.includes('home-page') ||
        href.includes('listings-management') ||
        body.includes('seller dashboard') ||
        body.includes('ethnicjunction') ||
        body.includes('seller hub') ||
        body.includes('logout') ||
        body.includes('sign out')
      );
    });

    if (!await checkSession()) {
      deleteEncryptedCookies(cookiesPath);
      deleteEncryptedCookies(fallbackCookiesPath);

      if (!config.password) {
        if (typeof onSessionExpiry === 'function') {
          // Trigger login modal opening on landing page
          try {
            await page.evaluate(() => {
              const modalOpen = Boolean(document.querySelector('input[name="username"], input[name="password"]'));
              if (!modalOpen) {
                const all = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
                const btn = all.find((el) => el.innerText?.trim().toLowerCase() === 'login' && el.getBoundingClientRect().top < 150 && el.offsetWidth > 0) ||
                            all.find((el) => el.innerText?.trim().toLowerCase() === 'login' && el.offsetWidth > 0);
                if (btn) btn.click();
              }
            });
          } catch {}
          onProgress('🔐 Session expired or login required. Opening in-view authentication prompt...');
          const authed = await onSessionExpiry(page);
          if (!authed) throw new Error('Seller Hub login required. Complete Human Login (2FA), then retry extraction.');
        } else {
          throw new Error('Seller Hub login required. Complete Human Login (2FA), then retry extraction.');
        }
      } else {
        onProgress('Signing in to Flipkart Seller Hub...');
        
        // 1. Open login modal if not already open
        let isModalOpen = await page.evaluate(() => {
          const inp = document.querySelector('input[name="username"], input[name="password"], input[placeholder*="Username"]');
          return Boolean(inp && inp.offsetWidth > 0);
        });

        if (!isModalOpen) {
          await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
            const headerBtn = all.find((el) => el.innerText?.trim().toLowerCase() === 'login' && el.getBoundingClientRect().top < 150 && el.offsetWidth > 0) ||
                              all.find((el) => el.innerText?.trim().toLowerCase() === 'login' && el.offsetWidth > 0);
            if (headerBtn) headerBtn.click();
          });
          await delay(2000);
        }

        // 2. Wait for login inputs
        await page.waitForSelector('input[name="username"], input[name="password"], input[placeholder*="Username"], input[placeholder*="phone"]', { timeout: 15000 });

        // 3. Handle Username step if password field is not yet visible
        const passwordAlreadyVisible = await page.evaluate(() => {
          const pwd = document.querySelector('input[name="password"], input[type="password"]');
          return Boolean(pwd && pwd.offsetWidth > 0 && pwd.offsetHeight > 0);
        });

        const targetEmail = config.email || 'Vbexports@outlook.com';
        if (!passwordAlreadyVisible) {
          await page.waitForSelector('input[name="username"], input[placeholder*="Username"], input[placeholder*="phone"]', { visible: true, timeout: 15000 });
          await page.evaluate((uEmail) => {
            const u = document.querySelector('input[name="username"], input[placeholder*="Username"], input[placeholder*="phone"]');
            if (u) {
              u.focus();
              u.value = '';
              u.dispatchEvent(new Event('input', { bubbles: true }));
              u.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, targetEmail);
          await page.type('input[name="username"], input[placeholder*="Username"], input[placeholder*="phone"]', targetEmail, { delay: 35 });
          await delay(800);
          
          await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const nextBtn = btns.find((b) => b.innerText?.trim().toLowerCase() === 'next' && b.offsetWidth > 0);
            if (nextBtn) nextBtn.click();
          });
          await delay(2000);
        }

        // 4. Enter Password
        await page.waitForSelector('input[name="password"], input[type="password"]', { visible: true, timeout: 15000 });
        await page.evaluate(() => {
          const pwd = document.querySelector('input[name="password"], input[type="password"]');
          if (pwd) {
            pwd.focus();
            pwd.value = '';
            pwd.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
        await page.type('input[name="password"], input[type="password"]', config.password, { delay: 35 });
        await delay(800);

        // 5. Click Modal Login button specifically
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
          const modalBtn = btns.find((b) => {
            const text = b.innerText?.trim().toLowerCase();
            const rect = b.getBoundingClientRect();
            return (text === 'login' || text === 'log in') && rect.top > 120 && b.offsetWidth > 0;
          }) || btns.find((b) => b.innerText?.trim().toLowerCase() === 'login' && b.offsetWidth > 0);
          if (modalBtn) modalBtn.click();
        });

        // 6. Wait for authentication redirect and dismiss notification popup
        onProgress('Waiting for authentication and redirect to dashboard...');
        const pollStart = Date.now();
        let authenticated = false;
        while (Date.now() - pollStart < 40000) {
          await delay(1200);
          authenticated = await page.evaluate(() => {
            const href = window.location.href.toLowerCase();
            const body = document.body ? document.body.innerText.toLowerCase() : '';
            const hasPwd = Boolean(document.querySelector('input[type="password"]'));
            const isAuth = !hasPwd && (
              href.includes('#dashboard') ||
              href.includes('home-page') ||
              href.includes('listings-management') ||
              body.includes('ethnicjunction') ||
              body.includes('seller hub') ||
              body.includes('seller dashboard') ||
              body.includes('logout') ||
              body.includes('sign out')
            );
            // Dismiss notification prompt if present
            const notifButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));
            const dontAllow = notifButtons.find(b => b.innerText?.trim().toLowerCase() === "don't allow");
            if (dontAllow) dontAllow.click();

            return isAuth;
          });
          if (authenticated) break;
        }

        if (!authenticated) {
          if (typeof onSessionExpiry === 'function') {
            onProgress('🔐 2FA verification challenge required. Please complete OTP challenge in the browser viewport...');
            const authed = await onSessionExpiry(page);
            if (!authed) throw new Error('Seller Hub login is incomplete. Complete Human Login (2FA), then retry extraction.');
          } else {
            throw new Error('Seller Hub login is incomplete. Complete Human Login (2FA), then retry extraction.');
          }
        }
        const cookies = await page.cookies();
        if (cookies?.length) {
          saveEncryptedCookies(cookiesPath, cookies);
          if (marketplace === 'flipkart' || marketplace === 'shopsy' || marketplace === 'flipkart_shopsy') {
            saveEncryptedCookies(fallbackCookiesPath, cookies);
          }
          onProgress(`✓ Logged in to Flipkart Seller Hub! Saved ${cookies.length} session cookies.`);
        }
      }
    }
    let verticals = config.selectedVerticals?.length ? [...config.selectedVerticals] : [
      'ethnic_set', 'kurta', 'sari', 'top', 'fabric', 'blouse', 'lehenga_choli', 'gown', 'shopsy_kurta', 'shopsy_ethnic_set'
    ];
    if (marketplace === 'shopsy') {
      verticals = verticals.filter((vertical) => vertical.startsWith('shopsy_'));
      if (!verticals.length) verticals = ['shopsy_kurta', 'shopsy_ethnic_set'];
    } else if (marketplace === 'flipkart') {
      verticals = verticals.filter((vertical) => !vertical.startsWith('shopsy_'));
    }
    if (!verticals.length) throw new Error('No verticals selected for this marketplace.');
    const effectiveDate = new Date().toISOString().slice(0, 10);
    const data = [];
    for (const vertical of verticals) {
      const isShopsyVertical = vertical.toLowerCase().startsWith('shopsy_') || marketplace === 'shopsy';
      for (const fulfilment of ['non-fbf', 'fbf']) {
        const queryVertical = vertical.replace(/^shopsy_/, '');
        const queryMarketplace = isShopsyVertical ? 'shopsy' : 'flipkart';
        const query = { marketplace: queryMarketplace, fulfillment: fulfilment, date: `${effectiveDate} 12:00:00`, vertical: queryVertical };
        onProgress(`Extracting ${vertical} (${fulfilment})...`);
        await safeGoto(`https://seller.flipkart.com/index.html#dashboard/payments/rate-card?query=${encodeURIComponent(JSON.stringify(query))}`, {
          waitUntil: 'load', timeout: 35000
        });
        // Wait dynamically for rate-card XHR data to render into table elements
        if (typeof page.waitForSelector === 'function') {
          await page.waitForSelector('table tr td, table tr th', { timeout: 8000 }).catch(() => null);
        }
        let tables = [];
        const pollDeadline = Date.now() + (config.visible ? 8000 : 6000);
        while (Date.now() < pollDeadline) {
          tables = await page.evaluate(() => Array.from(document.querySelectorAll('table')).map(
            (table) => Array.from(table.querySelectorAll('tr')).map(
              (row) => Array.from(row.querySelectorAll('th, td')).map((cell) => cell.innerText.trim())
            )
          ));
          if (tables.some((table) => table.length > 1)) break;
          await delay(800);
        }
        const hasTables = tables.some((table) => table.length > 1);
        if (!hasTables && !isShopsyVertical) {
          onProgress(`⚠️ No rate card tables found for ${vertical} (${fulfilment}). Skipping...`);
          continue;
        }
        data.push({
          ...parseRateCardTables(tables, vertical, effectiveDate, query.marketplace),
          fulfilment_type: fulfilment === 'fbf' ? 'FBF' : 'NON_FBF'
        });
      }
    }
    if (data.length === 0) {
      throw new Error('No rate card tables found for any selected vertical. Nothing was staged.');
    }
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    const stagingFile = path.join(stagingDir, `ratecards_${Date.now()}.json`);
    fs.writeFileSync(stagingFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    return { success: true, data, stagingFile };
  } catch (error) {
    return { success: false, error: error.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
