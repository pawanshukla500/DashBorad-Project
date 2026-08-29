import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool } from '../db/index.js';

dotenv.config({ path: path.resolve(fileURLToPath(import.meta.url), '../../.env') });

async function run() {
  try {
    const pool = getPool();
    const res = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'orders'");
    console.log(res.rows.map(r=>r.column_name));
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
