import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../db/index.js';

dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), '../../.env') });

async function run() {
  try {
    const pool = getPool();
    const res = await pool.query("SELECT DISTINCT category, brand FROM orders WHERE category IS NOT NULL AND brand IS NOT NULL ORDER BY category, brand");
    console.log(JSON.stringify(res.rows.slice(0, 10)));
    console.log('Total:', res.rows.length);
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
