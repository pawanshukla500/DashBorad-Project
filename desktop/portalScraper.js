import fs from 'node:fs';
import path from 'node:path';
import { getBrowserRuntime, requireChromeExecutable } from './browserRuntime.js';
import { getResolvedUserDataDir, loadEncryptedCookies, saveEncryptedCookies } from './cookieVault.js';

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
  delay = wait
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
      if (cookies?.length) await page.setCookie(...cookies);
    }
    await page.goto('https://seller.flipkart.com/index.html#dashboard/home-page', { waitUntil: 'networkidle2', timeout: 45000 });
    const checkSession = () => page.evaluate(() => {
      const body = document.body?.innerText.toLowerCase() || '';
      return !document.querySelector('input[type="password"]') &&
        (body.includes('seller dashboard') || body.includes('logout') || body.includes('sign out'));
    });
    if (!await checkSession()) {
      if (!config.password) throw new Error('Seller Hub login required. Complete Human Login (2FA), then retry extraction.');
      onProgress('Session expired. Signing in to Seller Hub...');
      await page.goto('https://seller.flipkart.com/', { waitUntil: 'networkidle2', timeout: 45000 });
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('button, a')).find((el) => el.innerText?.trim() === 'Login')?.click();
      });
      await page.waitForSelector('input[name="username"]', { visible: true, timeout: 15000 });
      await page.type('input[name="username"]', config.email, { delay: 40 });
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('button')).find((el) => el.innerText?.trim().toLowerCase() === 'next')?.click();
      });
      await page.waitForSelector('input[name="password"], input[type="password"]', { visible: true, timeout: 15000 });
      await page.type('input[name="password"], input[type="password"]', config.password, { delay: 40 });
      await page.evaluate(() => {
        Array.from(document.querySelectorAll('button')).find((el) => el.innerText?.trim().toLowerCase() === 'login')?.click();
      });
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null);
      await delay(4000);
      if (!await checkSession()) throw new Error('Seller Hub login is incomplete. Complete Human Login (2FA), then retry extraction.');
      const cookies = await page.cookies();
      saveEncryptedCookies(cookiesPath, cookies);
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
      for (const fulfilment of ['non-fbf', 'fbf']) {
        const query = { marketplace: vertical.startsWith('shopsy_') ? 'shopsy' : 'flipkart', fulfillment: fulfilment, date: `${effectiveDate} 12:00:00`, vertical };
        onProgress(`Extracting ${vertical} (${fulfilment})...`);
        await page.goto(`https://seller.flipkart.com/index.html#dashboard/payments/rate-card?query=${encodeURIComponent(JSON.stringify(query))}`, {
          waitUntil: 'networkidle2', timeout: 35000
        });
        await delay(config.visible ? 3000 : 2000);
        const tables = await page.evaluate(() => Array.from(document.querySelectorAll('table')).map(
          (table) => Array.from(table.querySelectorAll('tr')).map(
            (row) => Array.from(row.querySelectorAll('th, td')).map((cell) => cell.innerText.trim())
          )
        ));
        if (!tables.some((table) => table.length > 1)) throw new Error(`No rate card tables found for ${vertical} (${fulfilment}). Nothing was staged.`);
        data.push({
          ...parseRateCardTables(tables, vertical, effectiveDate, query.marketplace),
          fulfilment_type: fulfilment === 'fbf' ? 'FBF' : 'NON_FBF'
        });
      }
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
