#!/usr/bin/env node
/**
 * ReconCentral RateCard CLI & Headless Worker (Cross-Platform: Windows & Linux)
 *
 * Standalone CLI worker for Flipkart & Shopsy brand-wise rate card extraction,
 * change detection against PostgreSQL, automatic period closure, and Excel export.
 *
 * Usage:
 *   node desktop/worker.js
 *   node desktop/worker.js --marketplace=both
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
} from './rateCardService.js';
import {
  generateBrandwiseRateCardExcel,
  DEFAULT_EXCEL_PATH
} from './excelExport.js';
import { getDesktopPool, getDesktopPool as getPool } from './db.js';

// Parse CLI arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
ReconCentral RateCard Worker CLI (Windows & Linux)

Options:
  --marketplace=<flipkart|shopsy|both|myntra_vb|myntra_ej|meesho>   Target marketplace channel (default: both)
  --brand=<name|all>                     Filter by brand (e.g. "Sangria", default: all)
  --auto-sync, -y                        Autonomous auto-sync: commit verified rate shifts to PostgreSQL
  --allow-anomalies                      Allow committing autonomous changes even when anomalies are flagged
  --export-excel                         Generate multi-sheet Excel workbook on completion
  --excel-path=<path>                    Custom output path for Excel file
  --interactive, --visible               Launch visible Chrome browser for visual tour
  --help, -h                             Show this help message
`);
  process.exit(0);
}

const isInteractive = args.includes('--interactive') || args.includes('--visible');
const autoSync = args.includes('--auto-sync') || args.includes('-y');
const allowAnomalies = args.includes('--allow-anomalies');
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

/**
 * Exports current published PostgreSQL rate card records into a multi-sheet Excel workbook.
 *
 * @param {import('pg').Pool} pool - Database pool instance.
 * @param {(msg: string) => void} onProgress - Progress reporter callback.
 * @returns {Promise<object|null>} Result containing generated filePath and metadata, or null if skipped.
 */
async function exportPublishedWorkbook(pool, onProgress) {
  if (!shouldExportExcel) return null;
  onProgress('\nGenerating multi-sheet workbook from published database rates...');
  const targetPath = customExcelPath || DEFAULT_EXCEL_PATH;
  const result = await generateBrandwiseRateCardExcel(targetPath, pool);
  console.log(`✓ Excel Workbook Generated: ${result.filePath}`);
  console.log(`  Sheets: ${result.sheets?.join(', ') || 'All Sheets'}`);
  console.log(`  Total Records: ${result.totalRecords ?? (result.commissionSlabs || 'N/A')}`);
  return result;
}

/**
 * Executes the standalone RateCard worker pipeline: scrapes Seller Hub rate parameters,
 * runs rate change detection against PostgreSQL, auto-syncs if requested, and exports Excel.
 *
 * @returns {Promise<void>}
 */
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
    onProgress(`Reading published database snapshot for ${marketplaceArg.toUpperCase()}...`);
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

    const withoutFsn = rateCards.filter(rateCard => !/^[A-Z0-9]{16}$/i.test(String(rateCard.sample_fsn || '').trim()));
    if (withoutFsn.length) {
      const skipped = [...new Set(withoutFsn.map(rateCard => `${rateCard.marketplace}:${rateCard.category}:${rateCard.brand}`))];
      onProgress(`Skipping ${skipped.length} rate-card profile(s) without a valid 16-character database FSN: ${skipped.join(', ')}`);
    }
    rateCards = rateCards.filter(rateCard => /^[A-Z0-9]{16}$/i.test(String(rateCard.sample_fsn || '').trim()));

    if (rateCards.length === 0) {
      onProgress(`No active FSN-backed rate cards configured for channel "${marketplaceArg}". Database sync skipped.`);
      console.log(`\n✓ Staged 0 rate card profiles for ${marketplaceArg.toUpperCase()}.`);
      await exportPublishedWorkbook(pool, onProgress);
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
      console.log('✓ All rate parameters match active PostgreSQL records 100%. Database is up-to-date (0 changes).');
    } else {
      changes.forEach((c, i) => {
        const mark = c.anomaly ? '⚠️ [ANOMALY]' : '[CHANGE]';
        console.log(`[#${i + 1}] ${mark} ${c.type.toUpperCase()} | ${c.marketplace.toUpperCase()} | ${c.category} (${c.brand})`);
        console.log(`     Slab:    ${c.slab || 'General'}`);
        console.log(`     Old:     ${c.oldRate ?? 'None'}  -->  New: ${c.newRate} (${c.reason})`);
      });

      if (autoSync) {
        if (!rateCards || rateCards.length === 0 || !rateCards.some(r => (r.commissions && r.commissions.length > 0) || (r.fixedFees && r.fixedFees.length > 0))) {
          console.warn('⚠️ Auto-sync blocked: Current rate cards cannot be verified. Review Seller Hub extraction first.');
          return;
        }
        const anomalyChanges = changes.filter(c => c.anomaly);
        if (anomalyChanges.length > 0 && !allowAnomalies) {
          console.warn(`\n⚠️ Auto-sync skipped: ${anomalyChanges.length} rate anomaly/anomalies detected that require human verification.`);
          console.warn('   Run with --allow-anomalies to commit anomalous rates autonomously, or review in the desktop UI.');
        } else {
          onProgress(`⚡ Autonomous Auto-Sync active: Committing ${changes.length} rate adjustments to PostgreSQL...`);
          const syncResult = await syncBrandRateCardsToDatabase(rateCards, {
            sellerAccount: 'default',
            actor: 'worker-cli-autosync',
            runMetadata: { source: 'worker-cli', marketplace: marketplaceArg }
          }, pool);
          console.log(`✓ PostgreSQL Auto-Sync Completed: ${syncResult.message}`);
          if (syncResult.updated !== false) {
            console.log(`  Audit Version: ${syncResult.versionName}`);
            console.log(`  Commissions: ${syncResult.insertedCommissions}, Fixed: ${syncResult.insertedFixed}, Reverse: ${syncResult.insertedRev}, Collection: ${syncResult.insertedCollection}, Pick&Pack: ${syncResult.insertedPickPack || 0}`);
            if (syncResult.anomaliesCount > 0) {
              console.log(`⚠️ ${syncResult.anomaliesCount} anomalies recorded in version audit snapshot.`);
            }
            console.log(`\nℹ️ [NOTIFICATION] Rate changes recorded. No automated email sent directly by worker CLI (use ReconCentral cloud alerts).`);
          } else {
            console.log('  Database already matches active rates. 0 updates applied.');
          }
        }
      } else {
        console.log('\nReview current Seller Hub extractions in the desktop app or pass --auto-sync (-y) to commit autonomously.');
      }
    }

    // 5. Excel Export if requested. This is a published-database snapshot,
    // independent of whether the selected worker channel has FSN profiles.
    await exportPublishedWorkbook(pool, onProgress);

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
