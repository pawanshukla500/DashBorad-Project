/**
 * Desktop Brand-Wise Rate Card Excel & Data Export Engine
 * 
 * Standalone exporter that works across Windows and Linux.
 * Generates formatted multi-sheet Excel workbook or structured data export.
 */
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import { buildBrandRateCardSet } from './rateCardService.js';
import { getDesktopPool } from './db.js';

function resolveDefaultExcelPath() {
  const homeDir = os.homedir();
  const desktopDir = path.join(homeDir, 'Desktop');
  if (fsSync.existsSync(desktopDir)) {
    return path.join(desktopDir, 'Flipkart_Shopsy_Brandwise_RateCard.xlsx');
  }
  return path.join(homeDir, 'Flipkart_Shopsy_Brandwise_RateCard.xlsx');
}

export const DEFAULT_EXCEL_PATH = resolveDefaultExcelPath();

/**
 * Generate Excel workbook or structured file.
 */
export async function generateBrandwiseRateCardExcel(outputPath = DEFAULT_EXCEL_PATH, pool = null) {
  const p = pool || getDesktopPool();

  // 1. Get real-time brand rate card set
  const brandRateCards = await buildBrandRateCardSet(p);

  // 2. Prepare Data for Sheet 1: Brand_Commission_Summary
  const summaryRows = [];
  for (const card of brandRateCards) {
    for (const comm of card.commissions) {
      summaryRows.push({
        'Marketplace': card.marketplace.toUpperCase(),
        'Category / Vertical': card.category,
        'Brand Name': card.brand,
        'Sample FSN': card.sample_fsn,
        'Sample SKU': card.sample_sku,
        'Orders in DB': card.order_count,
        'Price Min (₹)': comm.price_min,
        'Price Max (₹)': comm.price_max === 999999 ? 'No Limit (>=' + comm.price_min + ')' : comm.price_max,
        'Commission Rate (%)': (comm.rate * 100).toFixed(2) + '%',
        'Effective Date': card.effectiveDate
      });
    }
  }

  // Sheet 2: Fixed_Fees
  const fixedRows = [];
  const seenFixed = new Set();
  for (const card of brandRateCards) {
    for (const fix of (card.fixedFees || [])) {
      const key = `${card.marketplace}_${card.category}_${fix.fulfilment_type}_${fix.price_min}_${fix.price_max}`;
      if (!seenFixed.has(key)) {
        seenFixed.add(key);
        fixedRows.push({
          'Marketplace': card.marketplace.toUpperCase(),
          'Category / Vertical': card.category,
          'Tier / Fulfilment': fix.fulfilment_type,
          'Price Min (₹)': fix.price_min,
          'Price Max (₹)': fix.price_max === 999999 ? 'No Limit' : fix.price_max,
          'Fixed Fee (₹)': fix.rate
        });
      }
    }
  }

  // Sheet 3: Reverse_Shipping
  const revRows = [];
  const seenRev = new Set();
  for (const card of brandRateCards) {
    for (const rev of (card.reverseShipping || [])) {
      const key = `${card.marketplace}_${card.category}_${rev.weight_slab}_${rev.price_min}_${rev.price_max}`;
      if (!seenRev.has(key)) {
        seenRev.add(key);
        revRows.push({
          'Marketplace': card.marketplace.toUpperCase(),
          'Category / Vertical': card.category,
          'Weight Slab': rev.weight_slab,
          'Price Min (₹)': rev.price_min,
          'Price Max (₹)': rev.price_max === 999999 ? 'No Limit' : rev.price_max,
          'Local Fee (₹)': rev.local_fee,
          'Zonal Fee (₹)': rev.zonal_fee,
          'National Fee (₹)': rev.national_fee
        });
      }
    }
  }

  // Sheet 4: Catalog_Samples
  const catalogRows = brandRateCards.map(c => ({
    'Marketplace': c.marketplace.toUpperCase(),
    'Category / Vertical': c.category,
    'Brand Name': c.brand,
    'Sample FSN': c.sample_fsn,
    'Sample SKU': c.sample_sku,
    'Orders in Database': c.order_count,
    'Commission Slabs': c.commissions.length,
    'Fixed Fee Slabs': (c.fixedFees || []).length,
    'Reverse Shipping Slabs': (c.reverseShipping || []).length
  }));

  // Sheet 5: Audit_Metadata
  const auditRows = [
    { 'Key': 'Generated At', 'Value': new Date().toISOString() },
    { 'Key': 'Total Brand Profiles', 'Value': brandRateCards.length },
    { 'Key': 'Total Commission Slabs', 'Value': summaryRows.length },
    { 'Key': 'Unique Fixed Fee Rules', 'Value': fixedRows.length },
    { 'Key': 'Unique Reverse Shipping Rules', 'Value': revRows.length },
    { 'Key': 'Engine', 'Value': 'ReconCentral Desktop Worker v1.0.0' }
  ];

  // Attempt XLSX workbook generation
  let XLSX = null;
  try {
    XLSX = (await import('xlsx')).default || (await import('xlsx'));
  } catch {
    try {
      XLSX = (await import('../backend/node_modules/xlsx/xlsx.mjs')).default;
    } catch {}
  }

  if (XLSX && typeof XLSX.utils?.book_new === 'function') {
    const wb = XLSX.utils.book_new();

    const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Brand_Commission');

    const wsFixed = XLSX.utils.json_to_sheet(fixedRows);
    XLSX.utils.book_append_sheet(wb, wsFixed, 'Fixed_Fees');

    const wsRev = XLSX.utils.json_to_sheet(revRows);
    XLSX.utils.book_append_sheet(wb, wsRev, 'Reverse_Shipping');

    const wsCatalog = XLSX.utils.json_to_sheet(catalogRows);
    XLSX.utils.book_append_sheet(wb, wsCatalog, 'Catalog_Samples');

    const wsAudit = XLSX.utils.json_to_sheet(auditRows);
    XLSX.utils.book_append_sheet(wb, wsAudit, 'Audit_Metadata');

    // Ensure output directory exists
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    XLSX.writeFile(wb, outputPath);

    return {
      success: true,
      filePath: outputPath,
      brandCount: brandRateCards.length,
      commissionSlabs: summaryRows.length,
      format: 'xlsx'
    };
  }

  // Fallback: structured JSON export if XLSX module is not packaged
  const jsonPath = outputPath.endsWith('.xlsx') ? outputPath.replace(/\.xlsx$/, '.json') : outputPath;
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, JSON.stringify({
    metadata: auditRows,
    brandCommissionSummary: summaryRows,
    fixedFees: fixedRows,
    reverseShipping: revRows,
    catalogSamples: catalogRows
  }, null, 2), 'utf8');

  return {
    success: true,
    filePath: jsonPath,
    brandCount: brandRateCards.length,
    commissionSlabs: summaryRows.length,
    format: 'json',
    note: 'Exported as JSON structure (install xlsx for native .xlsx binary).'
  };
}
