// Per-shipment ledger behind Amazon Sale Order totals.
//
// The Sale Orders export has one row per shipment. Rows for one order + SKU
// used to be summed within a file and then UPSERTed onto the order, so an
// order whose shipments fell into two monthly files kept only the last file's
// quantity and amount. Each shipment is now stored once (keyed by its shipment
// date-time and FC, the export having no shipment id), re-uploads replace the
// same shipment, and the order's quantity and amounts are the sum of all of
// its stored shipments, whatever order the files arrive in.
//
// Orders imported before this ledger existed have no shipment rows; their next
// upload covers only that file's shipments (as before) until the earlier file
// is uploaded again.
import { forEachDbBatch } from '../utils/dbBatch.js';

export const AMAZON_SALE_ORDER_SHIPMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS amazon_sale_order_shipments (
    order_id              TEXT NOT NULL,
    sku                   TEXT NOT NULL,
    shipment_key          TEXT NOT NULL,
    shipment_date         DATE,
    qty                   INTEGER NOT NULL DEFAULT 0,
    product_amount        NUMERIC(14,2) NOT NULL DEFAULT 0,
    item_tax              NUMERIC(14,2) NOT NULL DEFAULT 0,
    sale_shipping_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
    sale_gift_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
    uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (order_id, sku, shipment_key)
  )`;

let ensured = null;

/** Create the ledger once per process (idempotent; also run by initDb). */
export function ensureAmazonSaleOrderShipments(queryable) {
  if (!ensured) {
    ensured = Promise.resolve(queryable.query(AMAZON_SALE_ORDER_SHIPMENTS_DDL)).catch(error => {
      ensured = null;
      throw error;
    });
  }
  return ensured;
}

/** A shipment's identity within one order + SKU. */
export function saleOrderShipmentKey(shipmentDateTime, fcCode) {
  return `${shipmentDateTime || ''}|${String(fcCode || '').toUpperCase()}`;
}

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

/** Fold one parsed Sale Order row into the file's per-shipment map. */
export function addSaleOrderShipment(byShipment, record, fcCode) {
  const shipmentKey = saleOrderShipmentKey(record.purchase_date_time, fcCode);
  const id = `${record.order_id}\u0000${record.sku}\u0000${shipmentKey}`;
  const existing = byShipment.get(id);
  if (existing) {
    existing.qty += record.qty || 0;
    existing.product_amount = round2(existing.product_amount + (record.product_amount || 0));
    existing.item_tax = round2(existing.item_tax + (record.item_tax || 0));
    existing.sale_shipping_amount = round2(existing.sale_shipping_amount + (record.sale_shipping_amount || 0));
    existing.sale_gift_amount = round2(existing.sale_gift_amount + (record.sale_gift_amount || 0));
    return;
  }
  byShipment.set(id, {
    order_id: record.order_id,
    sku: record.sku,
    shipment_key: shipmentKey,
    shipment_date: record.order_date || null,
    qty: record.qty || 0,
    product_amount: round2(record.product_amount),
    item_tax: round2(record.item_tax),
    sale_shipping_amount: round2(record.sale_shipping_amount),
    sale_gift_amount: round2(record.sale_gift_amount),
  });
}

const SHIPMENT_FIELDS = [
  'order_id', 'sku', 'shipment_key', 'shipment_date', 'qty',
  'product_amount', 'item_tax', 'sale_shipping_amount', 'sale_gift_amount',
];

/** Upsert this file's shipments (a re-uploaded shipment replaces itself). */
export async function storeSaleOrderShipments(client, shipments) {
  await forEachDbBatch(shipments, SHIPMENT_FIELDS.length, async batch => {
    const values = [];
    const groups = batch.map(shipment => {
      const start = values.length;
      for (const field of SHIPMENT_FIELDS) values.push(shipment[field] ?? null);
      return `(${SHIPMENT_FIELDS.map((_, column) => `$${start + column + 1}`).join(', ')})`;
    });
    await client.query(`
      INSERT INTO amazon_sale_order_shipments (${SHIPMENT_FIELDS.join(', ')})
      VALUES ${groups.join(', ')}
      ON CONFLICT (order_id, sku, shipment_key) DO UPDATE SET
        shipment_date = EXCLUDED.shipment_date,
        qty = EXCLUDED.qty,
        product_amount = EXCLUDED.product_amount,
        item_tax = EXCLUDED.item_tax,
        sale_shipping_amount = EXCLUDED.sale_shipping_amount,
        sale_gift_amount = EXCLUDED.sale_gift_amount,
        uploaded_at = NOW()
    `, values);
  });
}

/**
 * Set each uploaded order's quantity, amounts and order date (first shipment)
 * from all of its stored shipments. Only rows whose values change are written.
 */
export async function applyShipmentTotalsToOrders(client, orderSkuPairs) {
  if (!orderSkuPairs.length) return 0;
  const orderIds = orderSkuPairs.map(([orderId]) => orderId);
  const skus = orderSkuPairs.map(([, sku]) => sku);
  const result = await client.query(`
    UPDATE orders o
    SET qty = s.qty,
        product_amount = s.product_amount,
        item_tax = s.item_tax,
        sale_shipping_amount = s.sale_shipping_amount,
        sale_gift_amount = s.sale_gift_amount,
        final_invoice_amount = s.product_amount,
        order_date = COALESCE(s.first_shipment, o.order_date)
    FROM (
      SELECT sh.order_id, sh.sku,
             SUM(sh.qty)::int                     AS qty,
             ROUND(SUM(sh.product_amount), 2)       AS product_amount,
             ROUND(SUM(sh.item_tax), 2)             AS item_tax,
             ROUND(SUM(sh.sale_shipping_amount), 2) AS sale_shipping_amount,
             ROUND(SUM(sh.sale_gift_amount), 2)     AS sale_gift_amount,
             MIN(sh.shipment_date)                  AS first_shipment
      FROM amazon_sale_order_shipments sh
      JOIN (SELECT DISTINCT * FROM unnest($1::text[], $2::text[]) AS p(order_id, sku)) p
        ON p.order_id = sh.order_id AND p.sku = sh.sku
      GROUP BY sh.order_id, sh.sku
    ) s
    WHERE o.marketplace = 'amazon'
      AND o.order_id = s.order_id
      AND o.sku = s.sku
      AND (o.qty, o.product_amount, o.item_tax, o.sale_shipping_amount, o.sale_gift_amount, o.final_invoice_amount, o.order_date)
          IS DISTINCT FROM
          (s.qty, s.product_amount, s.item_tax, s.sale_shipping_amount, s.sale_gift_amount, s.product_amount, COALESCE(s.first_shipment, o.order_date))
  `, [orderIds, skus]);
  return result.rowCount || 0;
}
