import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function addPickAndPackDb() {
  console.log('Adding FBF Pick & Pack table to Rate Card schema...');
  
  const queries = `
    -- Pick & Pack Fees depend on FSN/Vertical and Weight Slab + Zone (Only applies to FBF - Flipkart Fulfillment)
    CREATE TABLE IF NOT EXISTS flipkart_pick_pack_fees (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      fsn VARCHAR(255) NOT NULL,
      weight_slab_start_kg DECIMAL(10, 2) NOT NULL,
      weight_slab_end_kg DECIMAL(10, 2),
      local_base_fee DECIMAL(10, 2) NOT NULL,
      local_extra_fee DECIMAL(10, 2) NOT NULL,
      zonal_base_fee DECIMAL(10, 2) NOT NULL,
      zonal_extra_fee DECIMAL(10, 2) NOT NULL,
      national_base_fee DECIMAL(10, 2) NOT NULL,
      national_extra_fee DECIMAL(10, 2) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (fsn, weight_slab_start_kg)
    );
  `;

  try {
    await pool.query(queries);
    console.log('Pick and Pack table created successfully.');
  } catch (err) {
    console.error('Error creating table:', err);
  } finally {
    pool.end();
  }
}

addPickAndPackDb();
