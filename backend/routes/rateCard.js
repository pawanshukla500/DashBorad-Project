import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { scrapeRateCard } from '../services/rateCardScraper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Trigger a manual sync of the rate card
router.post('/sync', async (req, res) => {
  try {
    const { email, password } = process.env;
    const headless = process.env.SCRAPER_HEADLESS === 'true';
    
    // In a real app, you might want to run this asynchronously and return a Job ID.
    // For simplicity, we await it here.
    const result = await scrapeRateCard({ 
      email: email || process.env.FLIPKART_EMAIL, 
      password: password || process.env.FLIPKART_PASSWORD, 
      headless 
    });

    if (result.success) {
      res.json({ message: 'Rate card synced successfully.', data: result.data });
    } else {
      res.status(500).json({ error: 'Failed to sync rate card.', details: result.error });
    }
  } catch (error) {
    console.error('Route error /sync:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get Commission Fees
router.get('/commissions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM flipkart_commission_fees ORDER BY category, vertical');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get Fixed Fees
router.get('/fixed', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM flipkart_fixed_fees ORDER BY fulfillment_type, price_range_start');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get Collection Fees
router.get('/collection', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM flipkart_collection_fees ORDER BY payment_type');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get Shipping Fees
router.get('/shipping', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM flipkart_shipping_fees ORDER BY tier, weight_slab_grams');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
