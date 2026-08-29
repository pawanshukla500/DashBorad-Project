import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

async function run() {
  console.log('Launching Visible Chrome...');
  const browser = await puppeteer.launch({ 
    headless: false, // This makes the window pop up on your screen!
    defaultViewport: null,
    args: ['--start-maximized']
  });
  const page = await browser.newPage();
  
  console.log('Going to Flipkart Seller Hub...');
  await page.goto('https://seller.flipkart.com/index.html', { waitUntil: 'networkidle2' });
  
  console.log('\n====================================================');
  console.log('Please log in manually if you are not logged in.');
  console.log('The script will wait up to 60 seconds for you to reach the Dashboard...');
  console.log('====================================================\n');
  
  try {
      await page.waitForFunction(() => {
          return window.location.href.includes('#dashboard') && !window.location.href.includes('login');
      }, { timeout: 60000 });
      console.log('Dashboard detected!');
  } catch (e) {
      console.log('Wait finished. Proceeding to Rate Card...');
  }

  console.log('Navigating to Rate Card page...');
  await page.goto('https://seller.flipkart.com/index.html#dashboard/payments/rate-card', { waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 8000));
  
  const fsn = 'AZTH2F4U84PRZJGQ';
  console.log(`Searching for FSN: ${fsn}`);
  const inputSelector = 'input[placeholder="Search Product vertical or FSN"]';
  
  try {
      await page.waitForSelector(inputSelector, { timeout: 10000 });
      await page.type(inputSelector, fsn, { delay: 150 });
      await new Promise(r => setTimeout(r, 4000));
      
      console.log('Selecting from dropdown...');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 3000));

      console.log('Clicking Get Rate Card...');
      await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const target = btns.find(b => b.innerText.includes('Get Rate Card'));
          if (target && !target.disabled) {
              target.click();
          }
      });
      
      console.log('\n*** RATE CARD LOADED ***');
      console.log('You can now view the results on the screen.');
  } catch (e) {
      console.log('Could not find search box or interact:', e.message);
  }

  console.log('Leaving browser open for 3 minutes...');
  await new Promise(r => setTimeout(r, 180000));
  await browser.close();
  console.log('Browser closed.');
}

run();
