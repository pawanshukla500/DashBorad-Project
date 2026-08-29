import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: 'backend/.env' });

const targets = ['406-5801026-0047530', '407-2429081-2013132'];
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 30000,
});

async function query(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

try {
  const report = {};
  report.tables = await query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('orders', 'amazon_sale_orders', 'amazon_settlement_lines', 'amazon_settlements')
    ORDER BY table_name
  `);
  report.ordersColumns = await query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders'
    ORDER BY ordinal_position
  `);
  report.orderRows = await query(`
    SELECT *
    FROM orders
    WHERE marketplace = 'amazon' AND order_id = ANY($1::text[])
    ORDER BY order_id, order_item_id NULLS LAST
  `, [targets]);
  report.rawSettlementLines = await query(`
    SELECT settlement_id, posted_date, posted_at, transaction_type, amount_type,
           amount_description, amount, order_id, order_item_code, merchant_order_item_id,
           sku, quantity, fulfillment_id, shipment_id, adjustment_id, promotion_id
    FROM amazon_settlement_lines
    WHERE order_id = ANY($1::text[])
    ORDER BY order_id, posted_date, id
  `, [targets]);
  report.rawByParameter = await query(`
    SELECT order_id, transaction_type, amount_type, amount_description,
           COUNT(*)::int AS line_count, SUM(amount) AS signed_amount
    FROM amazon_settlement_lines
    WHERE order_id = ANY($1::text[])
    GROUP BY order_id, transaction_type, amount_type, amount_description
    ORDER BY order_id, MIN(id)
  `, [targets]);
  report.rawTotals = await query(`
    SELECT order_id, COUNT(*)::int AS line_count, COUNT(DISTINCT settlement_id)::int AS settlement_count,
           MIN(posted_date) AS first_posted_date, MAX(posted_date) AS last_posted_date,
           SUM(amount) AS signed_net_settlement
    FROM amazon_settlement_lines
    WHERE order_id = ANY($1::text[])
    GROUP BY order_id
    ORDER BY order_id
  `, [targets]);
  report.unifiedSettlements = await query(`
    SELECT *
    FROM unified_settlements
    WHERE marketplace = 'amazon' AND order_id = ANY($1::text[])
    ORDER BY order_id, payment_date, order_item_id
  `, [targets]);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
