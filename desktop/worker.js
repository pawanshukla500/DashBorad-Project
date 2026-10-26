#!/usr/bin/env node
/**
 * ReconCentral RateCard CLI & Headless Worker
 * 
 * Standalone worker that can run on any Windows or Linux PC,
 * via command line, systemd, or Windows Task Scheduler.
 * 
 * Usage:
 *   node desktop/worker.js
 *   node desktop/worker.js --auto-sync
 *   node desktop/worker.js --interactive
 *   node desktop/worker.js --verticals=kurta,ethnic_set,sari
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from backend/.env if available
const envPath = path.join(__dirname, '../backend/.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

import { scrapeFlipkartRateCards } from '../backend/services/flipkartRateCardExtractor.js';
import { detectRateChanges, syncRateCardsToDatabase } from '../backend/services/rateCardSyncEngine.js';

// Parse CLI arguments
const args = process.argv.slice(2);
const isInteractive = args.includes('--interactive');
const autoSync = args.includes('--auto-sync') || args.includes('-y');
const marketplaceArg = args.find(a => a.startsWith('--marketplace='))?.split('=')[1] || 'flipkart';
const verticalsArg = args.find(a => a.startsWith('--verticals='))?.split('=')[1];
const targetVerticals = verticalsArg ? verticalsArg.split(',').map(v => v.trim()) : null;

async function runWorker() {
  console.log('================================================================');
  console.log('⚡ ReconCentral Standalone RateCard Worker Engine');
  console.log(`Marketplace: ${marketplaceArg.toUpperCase()} | Auto-Sync: ${autoSync}`);
  console.log('================================================================\n');

  const onProgress = (msg) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${msg}`);
  };

  try {
    onProgress('Initiating rate card extraction...');
    const result = await scrapeFlipkartRateCards({
      headless: isInteractive ? false : 'new',
      verticals: targetVerticals,
      onProgress
    });

    if (!result.success) {
      console.error(`\n❌ Worker failed: ${result.error}`);
      process.exit(1);
    }

    onProgress(`Extraction complete. ${result.count} rate card records staged.`);
    onProgress('Running change detection against database...');

    const changes = await detectRateChanges(result.data, marketplaceArg, 'default');
    console.log(`\n----------------------------------------------------------------`);
    console.log(`🔍 Change Detection Summary: ${changes.length} adjustments found`);
    console.log(`----------------------------------------------------------------`);

    if (changes.length === 0) {
      console.log('✓ All active database rate cards match live marketplace fee schedules.');
    } else {
      changes.forEach((c, i) => {
        console.log(`[#${i + 1}] ${c.type.toUpperCase()} | ${c.category} | ${c.slab}`);
        console.log(`     Old: ${c.oldRate ?? 'None'}  -->  New: ${c.newRate} (${c.reason})`);
      });

      if (autoSync) {
        onProgress('\nAuto-sync is enabled. Committing changes to database...');
        const syncRes = await syncRateCardsToDatabase(result.data, {
          marketplace: marketplaceArg,
          sellerAccount: 'default'
        });
        onProgress(`✓ Database synced successfully! Published Version: ${syncRes.versionName}`);
      } else {
        console.log('\n💡 Tip: Run with --auto-sync to commit these rate changes directly to the database.');
      }
    }

    console.log('\n================================================================');
    console.log(' Worker run completed successfully.');
    console.log('================================================================');
    process.exit(0);

  } catch (err) {
    console.error('\n❌ Unhandled Worker Exception:', err);
    process.exit(1);
  }
}

runWorker();
