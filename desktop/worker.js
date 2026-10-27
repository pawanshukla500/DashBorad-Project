#!/usr/bin/env node
/**
 * ReconCentral RateCard CLI & Headless Worker (Cross-Platform: Windows & Linux)
 * 
 * Standalone CLI worker for Flipkart & Shopsy brand-wise rate card extraction,
 * change detection against PostgreSQL, automatic period closure, and Excel export.
 * 
 * Usage:
 *   node desktop/worker.js
 *   node desktop/worker.js --marketplace=both --auto-sync
 *   node desktop/worker.js --marketplace=shopsy --export-excel
 *   node desktop/worker.js --brand=Sangria --interactive
 *   node desktop/worker.js --help
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment from backend/.env natively
const envPath = path.join(__dirname, '../backend/.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

import { 
  getRealTimeBrandFsnSamples, 
  buildBrandRateCardSet, 
  detectBrandRateChanges, 
  syncBrandRateCardsToDatabase 
} from '../backend/services/brandRateCardService.js';
import { 
  generateBrandwiseRateCardExcel, 
  DEFAULT_EXCEL_PATH 
} from '../backend/services/brandwiseExcelExport.js';
import { getPool } from '../backend/db/index.js';

// Parse CLI arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
ReconCentral RateCard Worker CLI (Windows & Linux)

Options:
  --marketplace=<flipkart|shopsy|both|myntra_vb|myntra_ej|meesho>   Target marketplace channel (default: both)
  --brand=<name|all>                     Filter by brand (e.g. "Sangria", default: all)
  --auto-sync, -y                        Auto-commit changes to database with date auto-closing
  --export-excel                         Generate multi-sheet Excel workbook on completion
  --excel-path=<path>                    Custom output path for Excel file
  --interactive, --visible               Launch visible Chrome browser for visual tour
  --help, -h                             Show this help message
`);
  process.exit(0);
}

const isInteractive = args.includes('--interactive') || args.includes('--visible');
const autoSync = args.includes('--auto-sync') || args.includes('-y');
const shouldExportExcel = args.includes('--export-excel');
const SUPPORTED_WORKER_CHANNELS = ['both', 'flipkart', 'shopsy', 'flipkart_shopsy'];
const rawMarketplaceArg = args.find(a => a.startsWith('--marketplace='))?.split('=')[1] || 'both';
const marketplaceArg = rawMarketplaceArg.toLowerCase().trim();

if (['myntra_vb', 'myntra_ej', 'meesho', 'amazon', 'ajio', 'cocoblu', 'shopify'].includes(marketplaceArg)) {
  console.error(`❌ Automated rate card scraping for "${rawMarketplaceArg}" is scheduled for Phase 2.`);
  console.error(`Currently active scraper worker supports: ${SUPPORTED_WORKER_CHANNELS.join(', ')}`);
  process.exit(1);
}

if (!SUPPORTED_WORKER_CHANNELS.includes(marketplaceArg)) {
  console.error(`❌ Error: Unsupported marketplace channel "${rawMarketplaceArg}".`);
  console.error(`Supported channels: ${SUPPORTED_WORKER_CHANNELS.join(', ')}`);
  process.exit(1);
}

const brandArg = args.find(a => a.startsWith('--brand='))?.split('=')[1] || 'all';
const customExcelPath = args.find(a => a.startsWith('--excel-path='))?.split('=')[1];

async function runWorker() {
  console.log('======================================================================');
  console.log('⚡ ReconCentral Standalone RateCard Worker Engine');
  console.log(`Platform:    ${process.platform} (${process.arch})`);
  console.log(`Marketplace: ${marketplaceArg.toUpperCase()}`);
  console.log(`Brand:       ${brandArg}`);
  console.log(`Auto-Sync:   ${autoSync ? 'ENABLED (PostgreSQL)' : 'DISABLED (Preview only)'}`);
  console.log('======================================================================\n');

  const onProgress = (msg) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${msg}`);
  };

  try {
    const pool = getPool();

    // 1. Fetch Real-time Catalog & Sample FSNs
    onProgress('Querying live brand & FSN catalog from database...');
    const catalog = await getRealTimeBrandFsnSamples(pool);
    console.log(`✓ Retrieved ${catalog.length} catalog items from live order history.\n`);

    // 2. Build Brand-Wise Rate Card Set
    onProgress(`Generating rate card models for ${marketplaceArg.toUpperCase()}...`);
    let rateCards = await buildBrandRateCardSet(pool);

    // Fail-closed channel filtering
    if (marketplaceArg === 'flipkart') {
      rateCards = rateCards.filter(r => r.marketplace.toLowerCase() === 'flipkart');
    } else if (marketplaceArg === 'shopsy') {
      rateCards = rateCards.filter(r => r.marketplace.toLowerCase() === 'shopsy');
    } else if (marketplaceArg === 'both' || marketplaceArg === 'flipkart_shopsy') {
      rateCards = rateCards.filter(r => ['flipkart', 'shopsy'].includes(r.marketplace.toLowerCase()));
    } else {
      rateCards = [];
    }

    if (brandArg !== 'all') {
      rateCards = rateCards.filter(r => r.brand.toLowerCase() === brandArg.toLowerCase());
    }

    if (rateCards.length === 0) {
      onProgress(`No active rate cards configured for channel "${marketplaceArg}". Database sync skipped.`);
      console.log(`\n✓ Staged 0 rate card profiles for ${marketplaceArg.toUpperCase()}.`);
      console.log('======================================================================');
      console.log('✓ Worker run completed successfully.');
      console.log('======================================================================');
      process.exit(0);
    }

    console.log(`✓ Staged ${rateCards.length} rate card profiles.\n`);

    // 3. Change Detection Against Active PostgreSQL Records
    onProgress('Running change detection against active database tables (rc_commission, rc_fixed_fee, rc_reverse_shipping)...');
    const changes = await detectBrandRateChanges(rateCards, pool);

    console.log('\n----------------------------------------------------------------------');
    console.log(`🔍 Change Detection Summary: ${changes.length} rate adjustments detected`);
    console.log('----------------------------------------------------------------------');

    if (changes.length === 0) {
      console.log('✓ All active database rate cards match the latest fee schedules.');
    } else {
      changes.forEach((c, i) => {
        console.log(`[#${i + 1}] ${c.type.toUpperCase()} | ${c.marketplace.toUpperCase()} | ${c.category} (${c.brand})`);
        console.log(`     Slab:    ${c.slab || 'General'}`);
        console.log(`     Old:     ${c.oldRate ?? 'None'}  -->  New: ${c.newRate} (${c.reason})`);
      });

      // 4. Database Sync if requested
      if (autoSync) {
        onProgress('\nAuto-sync is enabled. Committing changes to PostgreSQL database...');
        const syncResult = await syncBrandRateCardsToDatabase(rateCards, { forceUpdate: true }, pool);
        console.log(`\n✓ Database Synced Successfully!`);
        console.log(`  Message:            ${syncResult.message}`);
        console.log(`  Commissions Saved:  ${syncResult.insertedCommissions}`);
        console.log(`  Fixed Fees Saved:   ${syncResult.insertedFixed}`);
        console.log(`  Reverse Saved:      ${syncResult.insertedRev}`);
        console.log(`  Version Snapshot:   ${syncResult.versionName}`);
      } else {
        console.log('\n💡 Tip: Run with --auto-sync to commit these rate changes directly to PostgreSQL.');
      }
    }

    // 5. Excel Export if requested
    if (shouldExportExcel || autoSync) {
      onProgress('\nGenerating multi-sheet Excel workbook...');
      const targetPath = customExcelPath || DEFAULT_EXCEL_PATH;
      const excelRes = await generateBrandwiseRateCardExcel(targetPath, pool);
      console.log(`✓ Excel Workbook Generated: ${excelRes.filePath}`);
      console.log(`  Sheets: ${excelRes.sheets.join(', ')}`);
      console.log(`  Total Records: ${excelRes.totalRecords}`);
    }

    console.log('\n======================================================================');
    console.log('✓ Worker run completed successfully.');
    console.log('======================================================================');
    process.exit(0);

  } catch (err) {
    console.error('\n❌ Unhandled Worker Exception:', err);
    process.exit(1);
  }
}

runWorker();
