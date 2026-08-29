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

async function initRateCardDb() {
  console.log('Initializing Rate Card tables with Flipkart exact structure...');
  
  const queries = `
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    -- Commissions depend on Vertical and Price Slab (sometimes FSN, but generally Vertical)
    CREATE TABLE IF NOT EXISTS flipkart_commission_fees (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      vertical VARCHAR(255) NOT NULL,
      price_range_start DECIMAL(10, 2) DEFAULT 0,
      price_range_end DECIMAL(10, 2),
      commission_percent DECIMAL(10, 2),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (vertical, price_range_start)
    );

    -- Fixed Fees depend on Vertical and Price Range
    CREATE TABLE IF NOT EXISTS flipkart_fixed_fees (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      vertical VARCHAR(255) NOT NULL,
      price_range_start DECIMAL(10, 2) NOT NULL,
      price_range_end DECIMAL(10, 2),
      fee_amount DECIMAL(10, 2) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (vertical, price_range_start)
    );

    -- Collection Fees depend on Vertical and Payment Type (Prepaid / Postpaid)
    CREATE TABLE IF NOT EXISTS flipkart_collection_fees (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      vertical VARCHAR(255) NOT NULL,
      payment_type VARCHAR(50) NOT NULL,
      fee_percent DECIMAL(10, 2),
      fee_flat DECIMAL(10, 2),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (vertical, payment_type)
    );

    -- Reverse Shipping Fees depend on Vertical, Price Slab, and Weight Slab
    CREATE TABLE IF NOT EXISTS flipkart_reverse_shipping_fees (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      vertical VARCHAR(255) NOT NULL,
      weight_slab_start_kg DECIMAL(10, 2) NOT NULL,
      weight_slab_end_kg DECIMAL(10, 2),
      price_range_start DECIMAL(10, 2) NOT NULL,
      price_range_end DECIMAL(10, 2),
      local_base_fee DECIMAL(10, 2) NOT NULL,
      local_extra_fee DECIMAL(10, 2) NOT NULL,
      zonal_base_fee DECIMAL(10, 2) NOT NULL,
      zonal_extra_fee DECIMAL(10, 2) NOT NULL,
      national_base_fee DECIMAL(10, 2) NOT NULL,
      national_extra_fee DECIMAL(10, 2) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Standard Forward Shipping Fees (generally depends on tier and weight, not vertical, but kept for completeness)
    CREATE TABLE IF NOT EXISTS flipkart_forward_shipping_fees (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tier VARCHAR(50) NOT NULL,
      weight_slab_start_kg DECIMAL(10, 2) NOT NULL,
      weight_slab_end_kg DECIMAL(10, 2),
      local_base_fee DECIMAL(10, 2) NOT NULL,
      zonal_base_fee DECIMAL(10, 2) NOT NULL,
      national_base_fee DECIMAL(10, 2) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    await pool.query(queries);
    console.log('Rate Card tables updated and created successfully.');
  } catch (err) {
    console.error('Error creating Rate Card tables:', err);
  } finally {
    pool.end();
  }
}

initRateCardDb();
