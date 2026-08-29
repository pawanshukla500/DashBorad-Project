import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, isDbConfigured, waitForDatabase } from '../db/index.js';

dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), '../../.env') });

const rules = [
  // 1. Commission (Referral Fee) - 5% for 'ALL' categories
  { fee_code: 'commission', program: 'ALL', calculation_basis: 'percent_of_sale', rate: 0.05, tax_rate: 0.18 },
  // 2. Fixed Closing Fee - varies by price
  { fee_code: 'fixed_closing_fee', program: 'ALL', calculation_basis: 'per_unit', rate: 5, price_max: 250, tax_rate: 0.18 },
  { fee_code: 'fixed_closing_fee', program: 'ALL', calculation_basis: 'per_unit', rate: 25, price_min: 251, price_max: 500, tax_rate: 0.18 },
  { fee_code: 'fixed_closing_fee', program: 'ALL', calculation_basis: 'per_unit', rate: 50, price_min: 501, price_max: 1000, tax_rate: 0.18 },
  { fee_code: 'fixed_closing_fee', program: 'ALL', calculation_basis: 'per_unit', rate: 70, price_min: 1001, tax_rate: 0.18 },
  // 3. FBA Pick & Pack
  { fee_code: 'fba_pick_pack', program: 'FBA', calculation_basis: 'per_unit', rate: 14, tax_rate: 0.18 },
  // 4. Flex Technology Fee
  { fee_code: 'technology_fee', program: 'FLEX', calculation_basis: 'per_unit', rate: 10, tax_rate: 0.18 },
  // 5. Weight Handling (Standard)
  { fee_code: 'fba_weight_handling', program: 'FBA', calculation_basis: 'per_unit', rate: 45, tax_rate: 0.18 },
  { fee_code: 'fba_weight_handling', program: 'FLEX', calculation_basis: 'per_unit', rate: 50, tax_rate: 0.18 }
];

async function seedAmazonRates() {
  if (!(await isDbConfigured())) {
    console.error('Database not configured. Check .env');
    process.exit(1);
  }

  await waitForDatabase();
  
  const pool = getPool();
  console.log('Seeding Amazon rate rules...');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Clear existing to avoid duplicates if run multiple times
    await client.query("DELETE FROM amazon_rate_card_rules WHERE seller_account = 'default'");
    
    for (const rule of rules) {
      const q = `
        INSERT INTO amazon_rate_card_rules 
          (seller_account, fee_code, program, category, calculation_basis, rate, tax_rate, price_min, price_max)
        VALUES 
          ('default', $1, $2, 'ALL', $3, $4, $5, $6, $7)
      `;
      await client.query(q, [
        rule.fee_code, 
        rule.program, 
        rule.calculation_basis, 
        rule.rate, 
        rule.tax_rate, 
        rule.price_min || 0, 
        rule.price_max || 999999
      ]);
    }
    
    await client.query('COMMIT');
    console.log('Successfully seeded Amazon rate rules.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error seeding Amazon rates:', error);
  } finally {
    client.release();
    process.exit(0);
  }
}

seedAmazonRates();
