import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../db/index.js';
import * as XLSX from 'xlsx';
import fs from 'fs';

dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), '../../.env') });

async function importCommissions() {
  const desktopPath = path.join(process.env.USERPROFILE || process.env.HOMEPATH || 'C:\\Users\\Pawan Shukla', 'Desktop', 'RateCard_Commission_Template.xlsx');
  
  if (!fs.existsSync(desktopPath)) {
    console.error(`File not found: ${desktopPath}`);
    process.exit(1);
  }

  try {
    const wb = XLSX.readFile(desktopPath);
    const ws = wb.Sheets["Commissions"];
    if (!ws) {
      throw new Error('Sheet "Commissions" not found.');
    }
    
    const rows = XLSX.utils.sheet_to_json(ws);
    console.log(`Found ${rows.length} rows to import.`);
    
    let imported = 0;
    const pool = getPool();
    
    for (const row of rows) {
      const marketplace = row.Marketplace || 'flipkart';
      const category = row.Category;
      const brand = row.Brand || '';
      const minP = parseFloat(row['Min Price']) || 0;
      const maxP = parseFloat(row['Max Price']) || 9999999;
      const rate = parseFloat(row['Commission Rate (%)']);
      
      if (category && !isNaN(rate)) {
        // Insert into rc_commission
        await pool.query(`
          INSERT INTO rc_commission (
            marketplace, seller_account, category, brand_name, 
            price_min, price_max, rate, start_date, end_date
          ) VALUES (
            $1, 'default', $2, $3, $4, $5, $6, '2020-01-01', NULL
          )
        `, [marketplace, category, brand, minP, maxP, rate]);
        imported++;
      }
    }
    
    console.log(`Successfully imported ${imported} commission rates!`);
    process.exit(0);
  } catch(e) {
    console.error('Error importing:', e);
    process.exit(1);
  }
}

importCommissions();
