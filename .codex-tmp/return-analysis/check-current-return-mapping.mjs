import dotenv from '../../backend/node_modules/dotenv/lib/main.js';
import pg from '../../backend/node_modules/pg/lib/index.js';

dotenv.config({ path: 'backend/.env' });
const { Pool } = pg;
const targets = [
  '407-8365071-6002717', '403-8356490-9934766', '403-5227845-7389133',
  '406-8857803-1548328', '402-6167748-6153950', '405-5053541-2926717',
  '407-1054434-3364350', '407-2429081-2013132', '403-8389911-4278738',
  '406-9548657-4077152', '406-3051678-2615531', '406-6613196-7311504',
  '171-9588059-7045139', '406-5049807-2517134', '402-6771191-3031565',
  '407-0503077-6129156', '405-3565258-4350740', '405-8641829-4174732',
];
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

try {
  const [rawReturns, orderReturns, directJoin, viewDefinition] = await Promise.all([
    pool.query(`
      SELECT order_id, sku, COUNT(*)::int AS return_rows,
             COALESCE(SUM(quantity), 0) AS return_quantity,
             COUNT(DISTINCT license_plate_number)::int AS lpns
      FROM returns
      WHERE marketplace = 'amazon' AND order_id = ANY($1::text[])
      GROUP BY order_id, sku
      ORDER BY order_id, sku
    `, [targets]),
    pool.query(`
      SELECT order_id, sku, COUNT(*)::int AS return_rows,
             COALESCE(SUM(quantity), 0) AS return_quantity,
             COUNT(DISTINCT license_plate_number)::int AS lpns
      FROM order_returns
      WHERE marketplace = 'amazon' AND order_id = ANY($1::text[])
      GROUP BY order_id, sku
      ORDER BY order_id, sku
    `, [targets]),
    pool.query(`
      SELECT r.order_id, r.sku, r.license_plate_number, o.id AS order_row_id,
             o.order_item_id, o.marketplace AS order_marketplace
      FROM returns r
      LEFT JOIN orders o
        ON o.order_id = r.order_id AND o.sku = r.sku AND o.marketplace = 'amazon'
      WHERE r.marketplace = 'amazon' AND r.order_id = ANY($1::text[])
      ORDER BY r.order_id, r.sku, r.license_plate_number
    `, [targets]),
    pool.query(`SELECT pg_get_viewdef('order_returns'::regclass, true) AS definition`),
  ]);
  console.log(JSON.stringify({
    rawReturns: rawReturns.rows,
    orderReturns: orderReturns.rows,
    directJoin: directJoin.rows,
    viewDefinition: viewDefinition.rows[0].definition,
  }, null, 2));
} finally {
  await pool.end();
}
