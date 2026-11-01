/**
 * Brand-Wise Rate Card Excel Export Engine
 * 
 * Generates formatted multi-sheet Excel workbook at:
 * C:\Users\Pawan Shukla\Desktop\Flipkart_Shopsy_Brandwise_RateCard.xlsx
 */
import XLSX from 'xlsx';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { loadPublishedRateCardSnapshot } from './brandRateCardService.js';
import { getPool } from '../db/index.js';

function resolveDefaultExcelPath() {
  const homeDir = os.homedir();
  const desktopDir = path.join(homeDir, 'Desktop');
  return path.join(desktopDir, 'Flipkart_Shopsy_Brandwise_RateCard.xlsx');
}

export const DEFAULT_EXCEL_PATH = resolveDefaultExcelPath();

export async function generateBrandwiseRateCardExcel(outputPath = DEFAULT_EXCEL_PATH, pool = null) {
  const p = pool || getPool();

  // Rates and order samples come from the same PostgreSQL snapshot.
  const { cards: brandRateCards, catalog } = await loadPublishedRateCardSnapshot(p);

  // 2. Prepare Data for Sheet 1: Brand_Commission_Summary
  const summaryRows = [];
  for (const card of brandRateCards) {
    for (const comm of card.commissions) {
      summaryRows.push({
        'Marketplace': card.marketplace.toUpperCase(),
        'Seller Account': card.seller_account || 'default',
        'Category / Vertical': card.category,
        'Brand Name': card.brand,
        'Sample FSN': card.sample_fsn,
        'Sample SKU': card.sample_sku,
        'Orders in DB': card.order_count,
        'Price Min (₹)': comm.price_min,
        'Price Max (₹)': comm.price_max === 999999 ? 'No Limit (>=' + comm.price_min + ')' : comm.price_max,
        'Commission Rate (%)': `${(comm.rate * 100).toFixed(1)}%`,
        'Effective Date': card.effectiveDate,
        'Status': 'Active'
      });
    }
  }

  // 3. Prepare Data for Sheet 2: Flipkart_Rates
  const flipkartRows = summaryRows.filter(r => r.Marketplace === 'FLIPKART');

  // 4. Prepare Data for Sheet 3: Shopsy_Rates
  const shopsyRows = summaryRows.filter(r => r.Marketplace === 'SHOPSY');

  // 5. Prepare Data for Sheet 4: Fixed_Fees
  const fixedFeeRows = [];
  for (const card of brandRateCards) {
    for (const f of card.fixedFees) {
      fixedFeeRows.push({
        'Marketplace': card.marketplace.toUpperCase(),
        'Seller Account': card.seller_account || 'default',
        'Category': card.category,
        'Seller Tier': f.fulfilment_type,
        'Order Value Min (₹)': f.price_min,
        'Order Value Max (₹)': f.price_max === 999999 ? 'Above' : f.price_max,
        'Fixed Fee (₹)': f.rate
      });
    }
  }
  // Deduplicate fixed fees for readability (grouped by mp, category, tier, price)
  const uniqueFixedFees = Array.from(new Map(
    fixedFeeRows.map(r => [`${r.Marketplace}_${r['Seller Account']}_${r.Category}_${r['Seller Tier']}_${r['Order Value Min (₹)']}`, r])
  ).values());

  // 6. Prepare Data for Sheet 5: Reverse_Shipping
  const revShippingRows = [];
  for (const card of brandRateCards) {
    for (const r of card.reverseShipping) {
      revShippingRows.push({
        'Marketplace': card.marketplace.toUpperCase(),
        'Seller Account': card.seller_account || 'default',
        'Category': card.category,
        'Weight Slab': r.weight_slab,
        'Price Range': `₹${r.price_min} - ₹${r.price_max === 999999 ? 'Above' : r.price_max}`,
        'Local (₹)': r.local_fee,
        'Zonal (₹)': r.zonal_fee,
        'National (₹)': r.national_fee
      });
    }
  }
  const uniqueRevShipping = Array.from(new Map(
    revShippingRows.map(r => [`${r.Marketplace}_${r['Seller Account']}_${r.Category}_${r['Weight Slab']}_${r['Price Range']}`, r])
  ).values());

  // 7. Prepare Data for Sheet 6: Sample_FSN_Catalog
  const catalogRows = catalog.map(c => ({
    'Marketplace': c.marketplace.toUpperCase(),
    'Seller Account': c.seller_account || 'default',
    'Category': c.category,
    'Brand Name': c.brand,
    'Real-time Sample FSN': c.sample_fsn,
    'Real-time Sample SKU': c.sample_sku,
    'Total Order Volume in DB': c.order_count
  }));

  // Build workbook
  const workbook = XLSX.utils.book_new();

  // Helper to append sheet with auto column widths
  function appendStyledSheet(data, sheetName) {
    const ws = XLSX.utils.json_to_sheet(data);
    if (data.length > 0) {
      const keys = Object.keys(data[0]);
      ws['!cols'] = keys.map(k => {
        const maxLen = Math.max(
          k.length,
          ...data.map(row => String(row[k] || '').length)
        );
        return { wch: Math.min(Math.max(maxLen + 3, 12), 40) };
      });
    }
    XLSX.utils.book_append_sheet(workbook, ws, sheetName);
  }

  appendStyledSheet(summaryRows, 'Brand_Commission_Summary');
  appendStyledSheet(flipkartRows, 'Flipkart_Rates');
  appendStyledSheet(shopsyRows, 'Shopsy_Rates');
  appendStyledSheet(uniqueFixedFees, 'Fixed_Fees');
  appendStyledSheet(uniqueRevShipping, 'Reverse_Shipping');
  appendStyledSheet(catalogRows, 'Sample_FSN_Catalog');

  // Write file to Desktop via buffer
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
  await fs.writeFile(outputPath, buffer);

  return {
    filePath: outputPath,
    sheetsCount: workbook.SheetNames.length,
    sheets: workbook.SheetNames,
    totalRecords: summaryRows.length,
    catalogCount: catalog.length
  };
}
