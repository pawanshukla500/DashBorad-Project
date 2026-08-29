import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: 'backend/.env' });
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 30000,
});
const targets = ['406-5801026-0047530', '407-2429081-2013132'];

try {
  const { rows } = await pool.query(`
    WITH sales AS (
      SELECT order_id, sku, fsn AS asin, fnsku, warehouse_id AS fc, fulfilment_type,
             order_date, delivery_city, delivery_state, shipping_zone,
             qty, product_amount, sale_shipping_amount, sale_gift_amount, final_invoice_amount
      FROM orders
      WHERE marketplace = 'amazon' AND order_id = ANY($1::text[])
    ), payments AS (
      SELECT
        order_id, order_item_code, sku, MAX(settlement_id) AS settlement_id,
        MAX(posted_date) AS posted_date, MAX(fulfillment_id) AS fulfillment_id,
        SUM(amount) AS net_settlement,
        SUM(amount) FILTER (WHERE amount_description = 'Principal') AS principal,
        SUM(amount) FILTER (WHERE amount_description = 'Product Tax') AS product_tax,
        SUM(amount) FILTER (WHERE amount_description = 'Shipping') AS shipping,
        SUM(amount) FILTER (WHERE amount_description IN ('Shipping tax', 'Shipping Tax')) AS shipping_tax,
        SUM(amount) FILTER (WHERE amount_description ILIKE 'Shipping discount%') AS shipping_discount,
        SUM(amount) FILTER (WHERE amount_description ILIKE 'Shipping tax discount%') AS shipping_tax_discount,
        SUM(amount) FILTER (WHERE amount_description = 'TCS-CGST') AS tcs_cgst,
        SUM(amount) FILTER (WHERE amount_description = 'TCS-SGST') AS tcs_sgst,
        SUM(amount) FILTER (WHERE amount_description = 'TCS-IGST') AS tcs_igst,
        SUM(amount) FILTER (WHERE amount_description = 'TDS (Section 194-O)') AS tds_194o,
        SUM(amount) FILTER (WHERE amount_description = 'FBA Pick & Pack Fee') AS pick_pack_base,
        SUM(amount) FILTER (WHERE amount_description = 'FBA Pick & Pack Fee CGST') AS pick_pack_cgst,
        SUM(amount) FILTER (WHERE amount_description = 'FBA Pick & Pack Fee SGST') AS pick_pack_sgst,
        SUM(amount) FILTER (WHERE amount_description = 'FBA Pick & Pack Fee IGST') AS pick_pack_igst,
        SUM(amount) FILTER (WHERE amount_description = 'FBA Weight Handling Fee') AS weight_base,
        SUM(amount) FILTER (WHERE amount_description = 'FBA Weight Handling Fee CGST') AS weight_cgst,
        SUM(amount) FILTER (WHERE amount_description = 'FBA Weight Handling Fee SGST') AS weight_sgst,
        SUM(amount) FILTER (WHERE amount_description = 'FBA Weight Handling Fee IGST') AS weight_igst,
        SUM(amount) FILTER (WHERE amount_description = 'Technology Fee') AS technology_base,
        SUM(amount) FILTER (WHERE amount_description = 'Technology Fee CGST') AS technology_cgst,
        SUM(amount) FILTER (WHERE amount_description = 'Technology Fee SGST') AS technology_sgst,
        SUM(amount) FILTER (WHERE amount_description = 'Technology Fee IGST') AS technology_igst,
        SUM(amount) FILTER (WHERE amount_description = 'Fixed closing fee') AS closing_base,
        SUM(amount) FILTER (WHERE amount_description = 'Fixed closing fee CGST') AS closing_cgst,
        SUM(amount) FILTER (WHERE amount_description = 'Fixed closing fee SGST') AS closing_sgst,
        SUM(amount) FILTER (WHERE amount_description = 'Fixed closing fee IGST') AS closing_igst
      FROM amazon_settlement_lines
      WHERE order_id = ANY($1::text[])
      GROUP BY order_id, order_item_code, sku
    )
    SELECT p.*, s.asin, s.fnsku, s.fc, s.fulfilment_type, s.order_date, s.delivery_city,
           s.delivery_state, s.shipping_zone, s.qty, s.product_amount, s.sale_shipping_amount,
           s.sale_gift_amount, s.final_invoice_amount,
           (COALESCE(p.principal, 0) + COALESCE(p.product_tax, 0)) AS product_sale_from_payment,
           (COALESCE(p.shipping, 0) + COALESCE(p.shipping_tax, 0)
             + COALESCE(p.shipping_discount, 0) + COALESCE(p.shipping_tax_discount, 0)) AS net_shipping_from_payment,
           (COALESCE(p.pick_pack_base, 0) + COALESCE(p.pick_pack_cgst, 0) + COALESCE(p.pick_pack_sgst, 0) + COALESCE(p.pick_pack_igst, 0)) AS pick_pack_total,
           (COALESCE(p.weight_base, 0) + COALESCE(p.weight_cgst, 0) + COALESCE(p.weight_sgst, 0) + COALESCE(p.weight_igst, 0)) AS weight_total,
           (COALESCE(p.technology_base, 0) + COALESCE(p.technology_cgst, 0) + COALESCE(p.technology_sgst, 0) + COALESCE(p.technology_igst, 0)) AS technology_total,
           (COALESCE(p.closing_base, 0) + COALESCE(p.closing_cgst, 0) + COALESCE(p.closing_sgst, 0) + COALESCE(p.closing_igst, 0)) AS closing_total
    FROM payments p
    LEFT JOIN sales s ON s.order_id = p.order_id AND s.sku = p.sku
    ORDER BY p.order_id, p.order_item_code
  `, [targets]);
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await pool.end();
}
