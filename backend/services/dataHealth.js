// Data health: finds stored rows that show the marks of the upload-parsing and
// derivation bugs fixed with the data-optimization hardening, so an operator
// knows exactly what to re-upload (or repair) instead of re-uploading
// everything. Read-only except repairMyntraPaymentColumns. Every check is
// independent: one that fails (for example a table that does not exist yet) is
// reported as unavailable and the others still run.
import { resetOrdersWithoutMyntraPayment } from './myntraSettlementReportingRollups.js';

const CHECKS = [
  {
    key: 'returns-before-order',
    title: 'Returns dated before their order',
    detail: 'A return cannot be requested before its order. These dates were most likely day/month-swapped by the old date parsing.',
    action: 'Re-upload the Orders and Returns files for these months; the new parsing replaces the swapped dates.',
    sql: `
      SELECT COALESCE(r.marketplace, 'flipkart') AS scope, COUNT(*)::int AS count,
             MIN(o.order_date)::text AS first_date, MAX(o.order_date)::text AS last_date
      FROM returns r
      JOIN orders o ON o.order_item_id = r.order_item_id
                   AND COALESCE(o.marketplace, 'flipkart') = COALESCE(r.marketplace, 'flipkart')
      WHERE COALESCE(r.marketplace, 'flipkart') <> 'amazon'
        AND r.return_requested_date < o.order_date
      GROUP BY 1`,
  },
  {
    key: 'payment-before-order',
    title: 'Flipkart payments dated before their order',
    detail: 'A settlement cannot be paid before the order exists. Either the order date or the payment date was most likely day/month-swapped.',
    action: 'Re-upload the Orders file and the FK Settlement report for these months.',
    sql: `
      SELECT 'flipkart' AS scope, COUNT(*)::int AS count,
             MIN(o.order_date)::text AS first_date, MAX(o.order_date)::text AS last_date
      FROM fk_settlement_orders f
      JOIN orders o ON o.order_item_id = f.order_item_id
      WHERE f.payment_date < o.order_date
      HAVING COUNT(*) > 0`,
  },
  {
    key: 'invoice-payment-before-invoice',
    title: 'Marketplace payments dated before their invoice',
    detail: 'Payment-file rows paid before their invoice date — the signature of the old CSV date guessing (05/04 read as 4 May).',
    action: 'Re-upload the payment / invoice files (CSV) for these accounts.',
    sql: `
      SELECT marketplace || COALESCE(' / ' || NULLIF(seller_account, 'default'), '') AS scope, COUNT(*)::int AS count,
             MIN(invoice_date)::text AS first_date, MAX(invoice_date)::text AS last_date
      FROM mp_invoices
      WHERE payment_date IS NOT NULL AND invoice_date IS NOT NULL AND payment_date < invoice_date
      GROUP BY 1`,
  },
  {
    key: 'future-dates',
    title: 'Dates in the future',
    detail: 'Order, return or invoice dates after today usually mean a swapped day and month.',
    action: 'Re-upload the files that contain these rows.',
    sql: `
      SELECT 'orders' AS scope, COUNT(*)::int AS count, MIN(order_date)::text AS first_date, MAX(order_date)::text AS last_date
      FROM orders WHERE order_date > CURRENT_DATE + 1 HAVING COUNT(*) > 0
      UNION ALL
      SELECT 'returns', COUNT(*)::int, MIN(return_requested_date)::text, MAX(return_requested_date)::text
      FROM returns WHERE return_requested_date > CURRENT_DATE + 1 HAVING COUNT(*) > 0
      UNION ALL
      SELECT 'payment files', COUNT(*)::int, MIN(invoice_date)::text, MAX(invoice_date)::text
      FROM mp_invoices WHERE invoice_date > CURRENT_DATE + 1 OR payment_date > CURRENT_DATE + 1 HAVING COUNT(*) > 0`,
  },
  {
    key: 'rows-dropped-on-upload',
    title: 'Uploads that dropped rows for an invalid date or amount',
    detail: 'The old parsing rejected valid dates (4/25/26) and negative currency (-₹1,234). Rows skipped for those reasons are recovered by uploading the same file again.',
    action: 'Re-upload each listed file.',
    sql: `
      SELECT l.filename || ' (' || l.data_type || ', ' || TO_CHAR(l.uploaded_at, 'YYYY-MM-DD') || ')' AS scope,
             COUNT(*)::int AS count, NULL::text AS first_date, NULL::text AS last_date
      FROM upload_skipped_rows s
      JOIN upload_log l ON l.id = s.upload_log_id
      WHERE l.data_cleared_at IS NULL
        AND s.skip_reason ~* '(date|amount)'
        AND s.skip_reason ~* '(invalid|empty)'
      GROUP BY l.id, l.filename, l.data_type, l.uploaded_at
      ORDER BY l.uploaded_at DESC
      LIMIT 50`,
  },
  {
    key: 'myntra-stale-payment-columns',
    title: 'Myntra orders still carrying removed payments',
    detail: 'Payment amounts left on orders whose Myntra payment rows were deleted or cleared before this fix.',
    action: 'Use "Repair" below; it clears only these orders’ payment columns.',
    repair: 'myntra-payment-columns',
    sql: `
      SELECT o.seller_account AS scope, COUNT(*)::int AS count,
             MIN(o.order_date)::text AS first_date, MAX(o.order_date)::text AS last_date
      FROM orders o
      WHERE o.marketplace = 'myntra'
        AND o.settlement_amount IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM mp_invoices i
          WHERE i.marketplace = 'myntra'
            AND i.seller_account = o.seller_account
            AND i.order_line_id = o.order_item_id
            AND COALESCE(i.order_type, '') <> 'nod'
        )
      GROUP BY 1`,
  },
  {
    key: 'amazon-orders-before-shipment-ledger',
    title: 'Amazon orders imported before the shipment ledger',
    detail: 'An order whose shipments fell into two monthly Sale Orders files only kept the later file’s quantity and amount. These orders have no shipment history yet.',
    action: 'Re-upload every Sale Orders file imported before the shipment ledger existed. Until all of them are re-uploaded, these orders cover only the shipments of the files re-uploaded so far.',
    sql: `
      SELECT 'amazon' AS scope, COUNT(*)::int AS count,
             MIN(o.order_date)::text AS first_date, MAX(o.order_date)::text AS last_date
      FROM orders o
      WHERE o.marketplace = 'amazon'
        AND o.order_item_id LIKE 'AMZ:%'
        AND NOT EXISTS (SELECT 1 FROM amazon_sale_order_shipments s WHERE s.order_id = o.order_id AND s.sku = o.sku)
      HAVING COUNT(*) > 0`,
  },
];

export const DATA_HEALTH_CHECK_KEYS = CHECKS.map(check => check.key);

export async function collectDataHealth(pool) {
  const results = await Promise.all(CHECKS.map(async ({ sql, ...check }) => {
    try {
      const { rows } = await pool.query(sql);
      const items = rows.filter(row => Number(row.count) > 0).map(row => ({
        scope: row.scope,
        count: Number(row.count),
        firstDate: row.first_date || null,
        lastDate: row.last_date || null,
      }));
      return { ...check, count: items.reduce((sum, item) => sum + item.count, 0), items };
    } catch (error) {
      return { ...check, count: 0, items: [], unavailable: error.message };
    }
  }));
  return {
    checkedAt: new Date().toISOString(),
    issues: results.filter(result => result.count > 0).length,
    checks: results,
  };
}

/** Clear payment columns of Myntra orders that have no payment row left. */
export async function repairMyntraPaymentColumns(pool) {
  return resetOrdersWithoutMyntraPayment(pool, null, null);
}
