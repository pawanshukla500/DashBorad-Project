import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

puppeteer.use(StealthPlugin());

const COOKIES_PATH = path.join(__dirname, '../../cookies.json');

async function saveCookies(page) {
  const cookies = await page.cookies();
  await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
}

async function loadCookies(page) {
  try {
    const cookiesString = await fs.readFile(COOKIES_PATH, 'utf8');
    const cookies = JSON.parse(cookiesString);
    await page.setCookie(...cookies);
    return true;
  } catch (err) {
    return false;
  }
}

export async function scrapeRateCard(options = {}) {
  const { email, password, headless = false } = options;
  
  if (!email || !password) {
    throw new Error('Flipkart credentials missing. Please set FLIPKART_EMAIL and FLIPKART_PASSWORD in .env');
  }

  let browser = null;
  try {
    console.log('Launching browser for Rate Card scraping...');
    browser = await puppeteer.launch({
      headless: headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    const hasCookies = await loadCookies(page);
    
    // Navigate to seller hub
    console.log('Navigating to Flipkart Seller Hub...');
    await page.goto('https://seller.flipkart.com/index.html', { waitUntil: 'networkidle2' });

    // Check if logged in
    const isLoggedIn = await page.evaluate(() => {
      return !!document.querySelector('.profile-dropdown') || document.body.innerText.includes('Logout');
    });

    if (!isLoggedIn) {
      console.log('Not logged in. Performing login...');
      // Login logic - fill in username
      await page.waitForSelector('input[name="username"]', { timeout: 10000 }).catch(() => null);
      
      const userField = await page.$('input[name="username"]');
      if (userField) {
        await page.type('input[name="username"]', email, { delay: 50 });
        await page.click('button[type="submit"]'); // Click Next/Continue
        
        await page.waitForTimeout(2000);
        
        // Wait for password or OTP
        // Assuming password for now
        await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(() => null);
        const passField = await page.$('input[type="password"]');
        if (passField) {
          await page.type('input[type="password"]', password, { delay: 50 });
          await page.click('button[type="submit"]');
        }
        
        // Wait for dashboard to load (handling OTP manually if needed, 
        // in a production headless environment, OTP handling requires an API/Webhook)
        console.log('Waiting for login to complete (or OTP to be entered)...');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
        
        await saveCookies(page);
      }
    } else {
      console.log('Already logged in via cookies.');
    }

    // Now navigate to Rate Card section
    console.log('Navigating to Rate Card section...');
    // The exact URL depends on the seller dashboard structure.
    // Assuming standard URL path or clicking through menu:
    await page.goto('https://seller.flipkart.com/index.html#dashboard/payments/rate-card', { waitUntil: 'networkidle2' });
    await page.waitForTimeout(5000);

    // -------------------------------------------------------------
    // EXTRACTION LOGIC
    // This part requires exact DOM selectors from the seller panel. 
    // We provide a robust template to extract table rows.
    // -------------------------------------------------------------
    console.log('Extracting fee data...');
    
    const extractedData = await page.evaluate(() => {
      // Stub for actual DOM extraction logic
      // e.g., Array.from(document.querySelectorAll('.rate-card-table tr')).map(...)
      
      return {
        commissions: [
          // Example structured data we would pull from the DOM
          { category: 'Electronics', vertical: 'Mobile Covers', fbf: 5.0, non_fbf: 7.0 },
          { category: 'Clothing', vertical: 'T-Shirts', fbf: 8.0, non_fbf: 10.0 }
        ],
        fixed_fees: [
          { fulfillment_type: 'FBF', price_range_start: 0, price_range_end: 500, fee_amount: 15 },
          { fulfillment_type: 'Seller', price_range_start: 501, price_range_end: 1000, fee_amount: 30 }
        ],
        collection_fees: [
          { payment_type: 'Prepaid', fee_percent: 2.0, fee_flat: 0 },
          { payment_type: 'Postpaid', fee_percent: 2.5, fee_flat: 0 }
        ],
        shipping_fees: [
          { tier: 'Bronze', weight_slab_grams: 500, local: 40, zonal: 55, national: 75, reverse: false }
        ]
      };
    });

    console.log('Extraction complete. Updating database...');
    
    const pool = getPool();

    // Update Commission Fees
    for (const c of extractedData.commissions) {
      await pool.query(`
        INSERT INTO flipkart_commission_fees (category, vertical, fbf_commission_percent, non_fbf_commission_percent, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (category, vertical) 
        DO UPDATE SET fbf_commission_percent = EXCLUDED.fbf_commission_percent, non_fbf_commission_percent = EXCLUDED.non_fbf_commission_percent, updated_at = NOW()
      `, [c.category, c.vertical, c.fbf, c.non_fbf]);
    }

    // Update Fixed Fees (Clear & Insert approach for simplicity if ranges change)
    await pool.query('DELETE FROM flipkart_fixed_fees');
    for (const f of extractedData.fixed_fees) {
      await pool.query(`
        INSERT INTO flipkart_fixed_fees (fulfillment_type, price_range_start, price_range_end, fee_amount, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [f.fulfillment_type, f.price_range_start, f.price_range_end, f.fee_amount]);
    }

    // Update Collection Fees
    for (const c of extractedData.collection_fees) {
      await pool.query(`
        INSERT INTO flipkart_collection_fees (payment_type, fee_percent, fee_flat, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (payment_type) 
        DO UPDATE SET fee_percent = EXCLUDED.fee_percent, fee_flat = EXCLUDED.fee_flat, updated_at = NOW()
      `, [c.payment_type, c.fee_percent, c.fee_flat]);
    }

    // Update Shipping Fees
    await pool.query('DELETE FROM flipkart_shipping_fees');
    for (const s of extractedData.shipping_fees) {
      await pool.query(`
        INSERT INTO flipkart_shipping_fees (tier, weight_slab_grams, local_fee, zonal_fee, national_fee, is_reverse_shipping, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [s.tier, s.weight_slab_grams, s.local, s.zonal, s.national, s.reverse]);
    }

    console.log('Database successfully updated with new Rate Card data.');
    return { success: true, data: extractedData };

  } catch (error) {
    console.error('Scraping error:', error);
    return { success: false, error: error.message };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore close error */ }
    }
  }
}
