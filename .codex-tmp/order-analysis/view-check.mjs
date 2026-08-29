import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: 'backend/.env' });
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

try {
  const [counts, amazonRows, definition] = await Promise.all([
    pool.query(`SELECT marketplace, COUNT(*)::int AS count FROM unified_settlements GROUP BY marketplace ORDER BY marketplace`),
    pool.query(`SELECT marketplace, order_id, order_item_id, seller_sku, payment_date, bank_settlement, sale_amount, fixed_fee, pick_pack_fee, shipping_fee, tcs, tds, gst_on_mp_fees, mp_other_fee FROM unified_settlements WHERE order_id = ANY($1::text[])`, [['406-5801026-0047530', '407-2429081-2013132']]),
    pool.query(`SELECT pg_get_viewdef('unified_settlements'::regclass, true) AS definition`),
  ]);
  console.log(JSON.stringify({ counts: counts.rows, amazonRows: amazonRows.rows, definition: definition.rows[0].definition }, null, 2));
} finally {
  await pool.end();
}
