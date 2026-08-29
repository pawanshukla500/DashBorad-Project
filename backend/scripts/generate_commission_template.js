import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../db/index.js';
import * as XLSX from 'xlsx';
import fs from 'fs';

dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), '../../.env') });

async function generateTemplate() {
  try {
    const pool = getPool();
    // Get unique marketplace, category, brand combinations
    const res = await pool.query(`
      SELECT DISTINCT 
        COALESCE(marketplace, 'flipkart') as marketplace, 
        category, 
        brand 
      FROM orders 
      WHERE category IS NOT NULL AND category != '' 
        AND brand IS NOT NULL AND brand != ''
      ORDER BY marketplace, category, brand
    `);

    const data = res.rows.map(row => ({
      Marketplace: row.marketplace,
      Category: row.category,
      Brand: row.brand,
      'Min Price': 0,
      'Max Price': 99999,
      'Commission Rate (%)': '' // Blank for user to fill
    }));

    if (data.length === 0) {
      console.log('No categories/brands found in the database. Generating an empty template...');
      data.push({
        Marketplace: 'flipkart',
        Category: 'apparel_set',
        Brand: 'Sangria',
        'Min Price': 0,
        'Max Price': 99999,
        'Commission Rate (%)': ''
      });
    }

    const ws = XLSX.utils.json_to_sheet(data);
    
    // Set column widths for readability
    const wscols = [
      {wch: 15}, // Marketplace
      {wch: 25}, // Category
      {wch: 25}, // Brand
      {wch: 12}, // Min Price
      {wch: 12}, // Max Price
      {wch: 20}  // Commission Rate
    ];
    ws['!cols'] = wscols;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Commissions");

    const desktopPath = path.join(process.env.USERPROFILE || process.env.HOMEPATH || 'C:\\Users\\Pawan Shukla', 'Desktop', 'RateCard_Commission_Template.xlsx');
    
    XLSX.writeFile(wb, desktopPath);
    console.log(`Successfully created template at: ${desktopPath}`);
    process.exit(0);
  } catch (err) {
    console.error('Error generating template:', err);
    process.exit(1);
  }
}

generateTemplate();
